import { commandRunner, type CommandRun } from "../workers/config-repo.js";

export type CheckState = "success" | "pending" | "failure" | "none";

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
  /** Every changed file, with the old name of a renamed one. */
  files: string[];
  /** False when GitHub could not list every file, so the escalation paths cannot be checked. */
  filesComplete: boolean;
  checks: CheckState;
  /** Names of checks that failed, for the escalation reason. */
  failedChecks: string[];
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
export function foldChecks(entries: RollupEntry[]): { state: CheckState; failed: string[] } {
  if (entries.length === 0) return { state: "none", failed: [] };
  const failed: string[] = [];
  let pending = false;
  for (const entry of entries) {
    const name = entry.name ?? entry.context ?? "check";
    if (entry.__typename === "StatusContext" || entry.state !== undefined) {
      const state = (entry.state ?? "").toUpperCase();
      if (state === "PENDING" || state === "EXPECTED") pending = true;
      else if (state !== "SUCCESS") failed.push(name);
      continue;
    }
    if ((entry.status ?? "").toUpperCase() !== "COMPLETED") {
      pending = true;
      continue;
    }
    if (!PASSING.has((entry.conclusion ?? "").toUpperCase())) failed.push(name);
  }
  if (failed.length > 0) return { state: "failure", failed };
  return { state: pending ? "pending" : "success", failed };
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

  private gh(args: string[]): Promise<string> {
    return this.exec(this.ghPath, args);
  }

  private async json<T>(args: string[]): Promise<T> {
    return JSON.parse(await this.gh(args)) as T;
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
    >([
      "issue",
      "list",
      "-R",
      repo,
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,title,body,author",
    ]);
    return issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      author: issue.author?.login ?? "",
      state: "OPEN",
    }));
  }

  async issue(repo: string, number: number): Promise<Issue> {
    const issue = await this.json<{
      number: number;
      title: string;
      body: string;
      author: { login: string } | null;
      state: "OPEN" | "CLOSED";
    }>(["issue", "view", String(number), "-R", repo, "--json", "number,title,body,author,state"]);
    return { ...issue, author: issue.author?.login ?? "" };
  }

  async reopenIssue(repo: string, number: number, comment: string): Promise<void> {
    await this.gh(["issue", "reopen", String(number), "-R", repo, "--comment", comment]);
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
    }>([
      "pr",
      "view",
      String(number),
      "-R",
      repo,
      "--json",
      "number,url,state,headRefOid,headRefName,baseRefName,isCrossRepository,mergeCommit",
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
      files,
      // GitHub lists at most 3000 files for a PR.
      filesComplete: files.length < 3000,
      checks: checks.state,
      failedChecks: checks.failed,
    };
  }

  /** Squash-merges the PR only if its head is still `headSha`, and returns the merge commit. */
  async merge(repo: string, number: number, headSha: string): Promise<string> {
    await this.gh([
      "pr",
      "merge",
      String(number),
      "-R",
      repo,
      "--squash",
      "--match-head-commit",
      headSha,
    ]);
    const merged = await this.pullRequest(repo, number);
    if (merged.mergeSha === null) throw new Error(`PR #${String(number)} has no merge commit.`);
    return merged.mergeSha;
  }

  /** Every check run and the latest status of each context on a commit, all pages. */
  async commitChecks(repo: string, sha: string): Promise<{ state: CheckState; failed: string[] }> {
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
