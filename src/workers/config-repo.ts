import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { FactoryConfig } from "../config/document.js";

const run = promisify(execFile);

/** Runs a command and returns its stdout; the error carries stderr. */
export type CommandRun = (file: string, args: string[], cwd?: string) => Promise<string>;

export const commandRunner: CommandRun = async (file, args, cwd) => {
  try {
    const { stdout } = await run(file, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new Error(`${file} ${args.join(" ")} failed: ${stderr.trim() || String(error)}`, {
      cause: error,
    });
  }
};

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isRepoSlug(slug: string): boolean {
  return SLUG.test(slug);
}

/** The files a version puts on a worker, keyed by path in the config repo. */
export function versionFiles(version: number, config: FactoryConfig): Record<string, string> {
  const instructions = config.instructions.factory ?? "";
  const files: Record<string, string> = {
    VERSION: `${String(version)}\n`,
    "claude/CLAUDE.md": instructions,
    "codex/AGENTS.md": instructions,
  };
  for (const name of config.factory.threadSkills) {
    for (const [path, text] of Object.entries(config.skills[name] ?? {})) {
      files[`claude/skills/${name}/${path}`] = text;
      files[`codex/skills/${name}/${path}`] = text;
    }
  }
  return files;
}

/**
 * Hephaestus's private config repo: one tag per deployed config version,
 * which deploy threads fetch on each worker. Only Hephaestus writes to it,
 * from a clone under ~/.hephaestus. Git authenticates through `gh`.
 */
export class ConfigRepo {
  constructor(
    private readonly dir: string,
    private readonly slug: string,
    private readonly gitPath: string,
    private readonly ghPath: string,
    private readonly exec: CommandRun = commandRunner,
  ) {
    if (!isRepoSlug(slug)) throw new Error(`${slug} is not an owner/repo name.`);
  }

  get url(): string {
    return `https://github.com/${this.slug}.git`;
  }

  /** Creates the private repo on GitHub when it does not exist yet. */
  async ensureRemote(): Promise<void> {
    try {
      await this.exec(this.ghPath, ["repo", "view", this.slug, "--json", "name"]);
    } catch {
      await this.exec(this.ghPath, [
        "repo",
        "create",
        this.slug,
        "--private",
        "--description",
        "Hephaestus config versions. Written only by Hephaestus.",
      ]);
    }
  }

  /** Commits the version's files, tags it `v<version>`, pushes both, and returns the commit SHA. */
  async publish(version: number, config: FactoryConfig): Promise<string> {
    await this.ensureClone();
    const tag = `v${String(version)}`;
    const existing = await this.tagCommit(tag);
    if (existing !== undefined) {
      await this.git(["push", "-q", "origin", `refs/tags/${tag}`]);
      return existing;
    }
    for (const entry of readdirSync(this.dir)) {
      if (entry !== ".git") rmSync(join(this.dir, entry), { recursive: true, force: true });
    }
    for (const [path, text] of Object.entries(versionFiles(version, config))) {
      const target = join(this.dir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    await this.git(["add", "-A"]);
    await this.git([
      "-c",
      "user.name=Hephaestus",
      "-c",
      "user.email=hephaestus@localhost",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      `Config version ${String(version)}`,
    ]);
    await this.git(["tag", tag]);
    await this.git(["push", "-q", "origin", "HEAD:refs/heads/main", `refs/tags/${tag}`]);
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  private async tagCommit(tag: string): Promise<string | undefined> {
    try {
      return (await this.git(["rev-parse", "--verify", "-q", `refs/tags/${tag}^{commit}`])).trim();
    } catch {
      return undefined;
    }
  }

  private async ensureClone(): Promise<void> {
    if (!existsSync(join(this.dir, ".git"))) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      await this.git(["init", "-q", "-b", "main"]);
      await this.git(["remote", "add", "origin", this.url]);
    }
    await this.git(["remote", "set-url", "origin", this.url]);
    await this.git(["fetch", "-q", "--tags", "origin"]).catch(() => undefined);
    const remoteMain = await this.git(["rev-parse", "--verify", "-q", "refs/remotes/origin/main"])
      .then((sha) => sha.trim())
      .catch(() => undefined);
    if (remoteMain !== undefined) await this.git(["reset", "-q", "--hard", remoteMain]);
  }

  private git(args: string[]): Promise<string> {
    return this.exec(
      this.gitPath,
      ["-c", `credential.https://github.com.helper=!${this.ghPath} auth git-credential`, ...args],
      this.dir,
    );
  }
}
