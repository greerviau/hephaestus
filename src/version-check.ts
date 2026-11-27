import { execFile } from "node:child_process";

/** Runs git in the service's checkout and resolves with its output. */
export type GitExec = (args: string[]) => Promise<string>;

const GIT_TIMEOUT_MS = 60_000;

/** Runs git in `root` with no prompt for credentials, so a fetch that needs them fails at once. */
export function gitIn(root: string, git: string): GitExec {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        git,
        ["-C", root, ...args],
        { timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
        (error, stdout) => {
          if (error === null) resolve(stdout);
          else reject(new Error(`git ${args.join(" ")} failed: ${error.message}`));
        },
      );
    });
}

/**
 * The commit the service runs, read once when it starts, and how many commits origin/main has
 * that it lacks. A failed fetch, or a checkout git cannot read, leaves that unknown.
 */
export class VersionCheck {
  private commit: string | undefined;
  private behind: number | undefined;
  constructor(private readonly options: { exec: GitExec }) {}

  /** Fetches origin/main every time, so the caller's interval sets how soon a new commit shows. */
  async refresh(): Promise<void> {
    try {
      // Read once: update moves the checkout before it restarts the service.
      this.commit ??= (await this.options.exec(["rev-parse", "HEAD"])).trim();
    } catch {
      return;
    }
    try {
      await this.options.exec(["fetch", "--quiet", "origin", "main"]);
      const count = (
        await this.options.exec(["rev-list", "--count", `${this.commit}..origin/main`])
      ).trim();
      this.behind = /^\d+$/.test(count) ? Number(count) : undefined;
    } catch {
      this.behind = undefined;
    }
  }

  /** The running commit and, when known, how far origin/main is ahead of it. */
  state(): { commit: string; behind?: number } | undefined {
    if (this.commit === undefined) return undefined;
    return this.behind === undefined
      ? { commit: this.commit }
      : { commit: this.commit, behind: this.behind };
  }
}
