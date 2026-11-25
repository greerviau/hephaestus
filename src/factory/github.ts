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
  mergeSha: string | null;
  files: string[];
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

  async pullRequest(repo: string, number: number): Promise<PullRequest> {
    const pr = await this.json<{
      number: number;
      url: string;
      state: PullRequest["state"];
      headRefOid: string;
      headRefName: string;
      baseRefName: string;
      mergeCommit: { oid: string } | null;
      files: { path: string }[] | null;
      statusCheckRollup: RollupEntry[] | null;
    }>([
      "pr",
      "view",
      String(number),
      "-R",
      repo,
      "--json",
      "number,url,state,headRefOid,headRefName,baseRefName,mergeCommit,files,statusCheckRollup",
    ]);
    const checks = foldChecks(pr.statusCheckRollup ?? []);
    return {
      number: pr.number,
      url: pr.url,
      state: pr.state,
      headSha: pr.headRefOid,
      headBranch: pr.headRefName,
      baseBranch: pr.baseRefName,
      mergeSha: pr.mergeCommit?.oid ?? null,
      files: (pr.files ?? []).map((file) => file.path),
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

  /** The checks on a commit, such as a merge commit on the default branch. */
  async commitChecks(repo: string, sha: string): Promise<{ state: CheckState; failed: string[] }> {
    const runs = await this.json<{
      check_runs: { name: string; status: string; conclusion: string | null }[];
    }>(["api", `repos/${repo}/commits/${sha}/check-runs`]);
    const statuses = await this.json<{ statuses: { context: string; state: string }[] }>([
      "api",
      `repos/${repo}/commits/${sha}/status`,
    ]);
    return foldChecks([
      ...runs.check_runs.map((run) => ({
        __typename: "CheckRun",
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
      })),
      ...statuses.statuses.map((status) => ({
        __typename: "StatusContext",
        context: status.context,
        state: status.state,
      })),
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
