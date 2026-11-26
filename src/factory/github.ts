import { commandRunner, type CommandRun } from "../workers/config-repo.js";

export type CheckState = "success" | "pending" | "failure" | "none";

/** GitHub may have merged the PR, and Hephaestus could not read back whether it did. */
/** The part of a PR that says whether and how it merged. */
export type MergeState = Pick<PullRequest, "number" | "state" | "headSha" | "mergeSha">;

/** How long an intake read may run before it is killed, so a stalled read cannot hold up the poll. */
export const INTAKE_READ_TIMEOUT_MS = 30_000;

/** The most open issues one read lists; an issue missing from a full list may still be open. */
export const OPEN_ISSUES_LIMIT = 200;

export class MergeOutcomeUnknownError extends Error {
  constructor(
    readonly number: number,
    options?: ErrorOptions,
  ) {
    super(`Could not tell whether PR #${String(number)} merged.`, options);
  }
}

async function retry<T>(work: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await work();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
    }
  }
  throw last;
}

/** GitHub refused the merge because the PR conflicts with its base branch. */
export class MergeConflictError extends Error {
  constructor(
    readonly number: number,
    options?: ErrorOptions,
  ) {
    super(`PR #${String(number)} has merge conflicts with its base branch.`, options);
  }
}

/** The PR was merged, but not by this merge call. */
export class AlreadyMergedError extends Error {
  constructor(
    readonly number: number,
    readonly mergeSha: string | null,
  ) {
    super(`PR #${String(number)} was already merged.`);
  }
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  author: string;
  state: "OPEN" | "CLOSED";
}

export interface PullRequest {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headSha: string;
  headBranch: string;
  baseBranch: string;
  /** Whether the PR comes from another repository. */
  fromFork: boolean;
  mergeSha: string | null;
  /** GitHub's view of whether the PR merges cleanly; it reads UNKNOWN for a while after the base moves. */
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** Every changed file, with the old name of a renamed one. */
  files: string[];
  /** False when GitHub could not list every file, so the escalation paths cannot be checked. */
  filesComplete: boolean;
  checks: CheckState;
  /** Names of checks that failed, for the escalation reason. */
  failedChecks: string[];
  /** Names of every check on the head commit, which the merge commit is expected to run too. */
  checkNames: string[];
}

interface RollupEntry {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
}

const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/** Folds GitHub check runs and commit statuses into one state. No checks at all is `none`. */
export interface CheckSummary {
  state: CheckState;
  failed: string[];
  /** Every check's name, finished or not. */
  names: string[];
  /** Names of checks that have finished. */
  finished: string[];
}

function isStatus(entry: RollupEntry): boolean {
  return entry.__typename === "StatusContext" || entry.state !== undefined;
}

/** A check's identity: a check run and a commit status of the same name are different checks. */
export function checkId(entry: RollupEntry): string {
  return `${isStatus(entry) ? "status" : "check"}:${entry.name ?? entry.context ?? "check"}`;
}

export function foldChecks(entries: RollupEntry[]): CheckSummary {
  const names = [...new Set(entries.map(checkId))];
  const finished: string[] = [];
  if (entries.length === 0) return { state: "none", failed: [], names, finished };
  const failed: string[] = [];
  let pending = false;
  for (const entry of entries) {
    const name = checkId(entry);
    if (isStatus(entry)) {
      const state = (entry.state ?? "").toUpperCase();
      if (state === "PENDING" || state === "EXPECTED") pending = true;
      else {
        finished.push(name);
        if (state !== "SUCCESS") failed.push(name);
      }
      continue;
    }
    if ((entry.status ?? "").toUpperCase() !== "COMPLETED") {
      pending = true;
      continue;
    }
    finished.push(name);
    if (!PASSING.has((entry.conclusion ?? "").toUpperCase())) failed.push(name);
  }
  if (failed.length > 0) return { state: "failure", failed, names, finished };
  return { state: pending ? "pending" : "success", failed, names, finished };
}

/**
 * GitHub through the `gh` CLI on the Hermes host, signed in as the owner.
 * Hephaestus reads checks itself, so the merge gate works without branch protection.
 */
export class GitHub {
  constructor(
    private readonly ghPath: string,
    private readonly exec: CommandRun = commandRunner,
  ) {}

  /**
   * Only reads that are safe to repeat take a timeout. A write that outlives
   * one may still have happened on GitHub, which the caller could not tell
   * from a failure.
   */
  private gh(args: string[], timeoutMs?: number): Promise<string> {
    return this.exec(this.ghPath, args, undefined, timeoutMs);
  }

  private async json<T>(args: string[], timeoutMs?: number): Promise<T> {
    return JSON.parse(await this.gh(args, timeoutMs)) as T;
  }

  async createIssue(repo: string, title: string, body: string): Promise<number> {
    const url = await this.gh(["issue", "create", "-R", repo, "--title", title, "--body", body]);
    const number = /\/issues\/(\d+)/.exec(url)?.[1];
    if (number === undefined) throw new Error(`gh issue create printed no issue URL: ${url}`);
    return Number(number);
  }

  async openIssues(repo: string): Promise<Issue[]> {
    const issues = await this.json<
      { number: number; title: string; body: string; author: { login: string } | null }[]
    >(
      [
        "issue",
        "list",
        "-R",
        repo,
        "--state",
        "open",
        "--limit",
        String(OPEN_ISSUES_LIMIT),
        "--json",
        "number,title,body,author",
      ],
      INTAKE_READ_TIMEOUT_MS,
    );
    return issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      author: issue.author?.login ?? "",
      state: "OPEN",
    }));
  }

  /** One issue; intake passes a timeout, so a stalled read cannot hold up its poll. */
  async issue(repo: string, number: number, timeoutMs?: number): Promise<Issue> {
    const issue = await this.json<{
      number: number;
      title: string;
      body: string;
      author: { login: string } | null;
      state: "OPEN" | "CLOSED";
    }>(
      ["issue", "view", String(number), "-R", repo, "--json", "number,title,body,author,state"],
      timeoutMs,
    );
    return { ...issue, author: issue.author?.login ?? "" };
  }

  async reopenIssue(repo: string, number: number, comment: string): Promise<void> {
    await this.gh(["issue", "reopen", String(number), "-R", repo, "--comment", comment]);
  }

  /** Repos the gh account owns, collaborates on, or reaches through an organization, for the Projects page's suggestions. */
  async repos(): Promise<string[]> {
    const listed = await this.gh(
      [
        "api",
        "user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=pushed",
        "--jq",
        ".[].full_name",
      ],
      INTAKE_READ_TIMEOUT_MS,
    );
    return [...new Set(listed.split("\n").filter((line) => line !== ""))].sort((a, b) =>
      a.localeCompare(b),
    );
  }

  /** The repo's owner/name as GitHub spells it; throws when gh cannot read the repo. */
  async canonicalName(repo: string): Promise<string> {
    const result = await this.json<{ nameWithOwner: string }>(
      ["repo", "view", repo, "--json", "nameWithOwner"],
      INTAKE_READ_TIMEOUT_MS,
    );
    return result.nameWithOwner;
  }

  async defaultBranch(repo: string): Promise<string> {
    const result = await this.json<{ defaultBranchRef: { name: string } }>([
      "repo",
      "view",
      repo,
      "--json",
      "defaultBranchRef",
    ]);
    return result.defaultBranchRef.name;
  }

  /**
   * A PR with every changed file and every check on its head commit. Both
   * lists are read through the paginated REST API, because `gh pr view`
   * returns at most 100 of each.
   */
  /**
   * The files under an evidence ref the engineer pushed, such as screenshots,
   * or undefined when the ref does not exist. At most `limit` files of up to
   * `maxBytes` each are read.
   */
  async evidence(
    repo: string,
    ref: string,
    limit = 6,
    maxBytes = 8 * 1024 * 1024,
  ): Promise<{ tree: string; files: { name: string; data: Buffer }[] } | undefined> {
    let commit: string;
    try {
      commit = (
        await this.json<{ object: { sha: string } }>(["api", `repos/${repo}/git/ref/${ref}`])
      ).object.sha;
    } catch (error) {
      if (/HTTP 404|Not Found/i.test(String(error))) return undefined;
      throw error;
    }
    const { tree } = await this.json<{ tree: { sha: string } }>([
      "api",
      `repos/${repo}/git/commits/${commit}`,
    ]);
    const listing = await this.json<{
      tree: { path: string; type: string; sha: string; size?: number }[];
    }>(["api", `repos/${repo}/git/trees/${tree.sha}`]);
    const files: { name: string; data: Buffer }[] = [];
    for (const entry of listing.tree) {
      if (files.length >= limit) break;
      if (entry.type !== "blob" || (entry.size ?? 0) > maxBytes) continue;
      const blob = await this.json<{ content: string; encoding: string }>([
        "api",
        `repos/${repo}/git/blobs/${entry.sha}`,
      ]);
      if (blob.encoding !== "base64") continue;
      files.push({ name: entry.path, data: Buffer.from(blob.content, "base64") });
    }
    // The tree, which stays the same when the same files are pushed again.
    return { tree: tree.sha, files };
  }

  /** Whether a PR merged, without its files or checks, so a checks outage cannot fail the read. */
  async mergeState(repo: string, number: number): Promise<MergeState> {
    const pr = await this.json<{
      number: number;
      state: PullRequest["state"];
      headRefOid: string;
      mergeCommit: { oid: string } | null;
    }>(["pr", "view", String(number), "-R", repo, "--json", "number,state,headRefOid,mergeCommit"]);
    return {
      number: pr.number,
      state: pr.state,
      headSha: pr.headRefOid,
      mergeSha: pr.mergeCommit?.oid ?? null,
    };
  }

  async pullRequest(repo: string, number: number): Promise<PullRequest> {
    const pr = await this.json<{
      number: number;
      url: string;
      state: PullRequest["state"];
      headRefOid: string;
      headRefName: string;
      baseRefName: string;
      isCrossRepository: boolean;
      mergeCommit: { oid: string } | null;
      mergeable?: PullRequest["mergeable"];
    }>([
      "pr",
      "view",
      String(number),
      "-R",
      repo,
      "--json",
      "number,url,state,headRefOid,headRefName,baseRefName,isCrossRepository,mergeCommit,mergeable",
    ]);
    const listed = await this.gh([
      "api",
      "--paginate",
      `repos/${repo}/pulls/${String(number)}/files?per_page=100`,
      "--jq",
      ".[] | .filename, (.previous_filename // empty)",
    ]);
    const files = [...new Set(listed.split("\n").filter((line) => line !== ""))];
    const checks = await this.commitChecks(repo, pr.headRefOid);
    return {
      number: pr.number,
      url: pr.url,
      state: pr.state,
      headSha: pr.headRefOid,
      headBranch: pr.headRefName,
      baseBranch: pr.baseRefName,
      fromFork: pr.isCrossRepository,
      mergeSha: pr.mergeCommit?.oid ?? null,
      mergeable: pr.mergeable ?? "UNKNOWN",
      files,
      // GitHub lists at most 3000 files for a PR.
      filesComplete: files.length < 3000,
      checks: checks.state,
      failedChecks: checks.failed,
      checkNames: checks.names,
    };
  }

  /** Squash-merges the PR only if its head is still `headSha`, and returns the merge commit. */
  /**
   * Squash-merges the PR only if its head is still `headSha`, and returns the
   * merge commit from GitHub's answer to the merge itself. A PR someone else
   * already merged raises {@link AlreadyMergedError}, so that merge is never
   * taken for Hephaestus's own.
   */
  async merge(repo: string, number: number, headSha: string, marker: string): Promise<string> {
    let answer: { merged?: boolean; sha?: string };
    try {
      answer = await this.json<{ merged?: boolean; sha?: string }>([
        "api",
        "-X",
        "PUT",
        `repos/${repo}/pulls/${String(number)}/merge`,
        "-f",
        "merge_method=squash",
        "-f",
        `sha=${headSha}`,
        "-f",
        `commit_message=${marker}`,
      ]);
    } catch (error) {
      // The reply may have been lost after GitHub merged; the marker in the commit says whose merge it was.
      const current = await retry(() => this.pullRequest(repo, number)).catch(() => undefined);
      if (current === undefined) throw new MergeOutcomeUnknownError(number, { cause: error });
      if (current.state !== "MERGED" || current.mergeSha === null) {
        // The refusal's wording varies, and mergeable can lag; either one names a conflict.
        if (
          current.state === "OPEN" &&
          // A head that moved is the gate's to handle, not a conflict to send back.
          current.headSha === headSha &&
          (current.mergeable === "CONFLICTING" || /merge conflict/i.test(String(error)))
        ) {
          throw new MergeConflictError(number, { cause: error });
        }
        throw error;
      }
      const ours = await this.mergedWith(repo, current.mergeSha, marker);
      if (ours === undefined) throw new MergeOutcomeUnknownError(number, { cause: error });
      if (ours) return current.mergeSha;
      throw new AlreadyMergedError(number, current.mergeSha);
    }
    if (answer.merged !== true || typeof answer.sha !== "string") {
      throw new Error(`GitHub did not merge PR #${String(number)}.`);
    }
    return answer.sha;
  }

  /** Whether a merge commit carries `marker`, or undefined when GitHub could not be read. */
  async mergedWith(repo: string, mergeSha: string, marker: string): Promise<boolean | undefined> {
    try {
      const message = await retry(() =>
        this.gh(["api", `repos/${repo}/commits/${mergeSha}`, "--jq", ".commit.message"]),
      );
      return message.includes(marker);
    } catch {
      return undefined;
    }
  }

  /** Every check run and the latest status of each context on a commit, all pages. */
  async commitChecks(repo: string, sha: string): Promise<CheckSummary> {
    const runs = (
      await this.gh([
        "api",
        "--paginate",
        `repos/${repo}/commits/${sha}/check-runs?per_page=100`,
        "--jq",
        '.check_runs[] | [.name, .status, (.conclusion // "")] | @tsv',
      ])
    )
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [name = "", status = "", conclusion = ""] = line.split("\t");
        return { __typename: "CheckRun", name, status, conclusion };
      });
    // Statuses come newest first; the first one per context is its current state.
    const latest = new Map<string, string>();
    for (const line of (
      await this.gh([
        "api",
        "--paginate",
        `repos/${repo}/commits/${sha}/statuses?per_page=100`,
        "--jq",
        ".[] | [.context, .state] | @tsv",
      ])
    ).split("\n")) {
      const [context, state] = line.split("\t");
      if (context === undefined || state === undefined || latest.has(context)) continue;
      latest.set(context, state);
    }
    return foldChecks([
      ...runs,
      ...[...latest].map(([context, state]) => ({ __typename: "StatusContext", context, state })),
    ]);
  }

  /** Opens GitHub's revert PR for a merged PR and returns its number. */
  async revertPullRequest(repo: string, number: number): Promise<number> {
    const { id } = await this.json<{ id: string }>([
      "pr",
      "view",
      String(number),
      "-R",
      repo,
      "--json",
      "id",
    ]);
    const result = await this.json<{
      data: { revertPullRequest: { revertPullRequest: { number: number } } };
    }>([
      "api",
      "graphql",
      "-f",
      "query=mutation($id: ID!) { revertPullRequest(input: {pullRequestId: $id}) { revertPullRequest { number } } }",
      "-f",
      `id=${id}`,
    ]);
    return result.data.revertPullRequest.revertPullRequest.number;
  }
}
