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

/** Publishes run one at a time per clone, across all ConfigRepo objects for it. */
const locks = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  locks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

export class NotPrivateError extends Error {
  constructor(slug: string) {
    super(`${slug} is not a private repo. Factory config must not be public; name a private repo.`);
  }
}

/**
 * Hephaestus's private config repo: one tag per deployed config version,
 * which deploy threads fetch on each worker. Only Hephaestus writes to it,
 * from a clone under ~/.hephaestus. Git authenticates through `gh`. Tags
 * carry this install's prefix, so a reinstall that starts again at version 1
 * cannot reuse an older install's tags.
 */
export class ConfigRepo {
  constructor(
    private readonly dir: string,
    private readonly slug: string,
    private readonly gitPath: string,
    private readonly ghPath: string,
    private readonly tagPrefix: string,
    private readonly exec: CommandRun = commandRunner,
  ) {
    if (!isRepoSlug(slug)) throw new Error(`${slug} is not an owner/repo name.`);
    if (!/^[A-Za-z0-9-]*$/.test(tagPrefix)) throw new Error(`Invalid tag prefix ${tagPrefix}.`);
  }

  get url(): string {
    return `https://github.com/${this.slug}.git`;
  }

  tagFor(version: number): string {
    return `${this.tagPrefix}v${String(version)}`;
  }

  /** Checks the repo is private, and creates it, private, when GitHub says it does not exist. */
  async ensureRemote(): Promise<void> {
    let found: { isPrivate: boolean } | undefined;
    try {
      found = JSON.parse(
        await this.exec(this.ghPath, ["repo", "view", this.slug, "--json", "isPrivate"]),
      ) as { isPrivate: boolean };
    } catch (error) {
      if (!/Could not resolve to a Repository/i.test(String(error))) throw error;
    }
    if (found !== undefined) {
      if (!found.isPrivate) throw new NotPrivateError(this.slug);
      return;
    }
    await this.exec(this.ghPath, [
      "repo",
      "create",
      this.slug,
      "--private",
      "--description",
      "Hephaestus config versions. Written only by Hephaestus.",
    ]);
  }

  /**
   * Commits the version's files, tags that commit, pushes both, and returns
   * the commit SHA. Publishing a version again returns its tagged commit, and
   * fails if the tag holds other files.
   */
  publish(version: number, config: FactoryConfig): Promise<string> {
    return serialized(this.dir, async () => {
      await this.ensureClone();
      const tag = this.tagFor(version);
      for (const entry of readdirSync(this.dir)) {
        if (entry !== ".git") rmSync(join(this.dir, entry), { recursive: true, force: true });
      }
      for (const [path, text] of Object.entries(versionFiles(version, config))) {
        const target = join(this.dir, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, text);
      }
      await this.git(["add", "-A"]);
      const tree = (await this.git(["write-tree"])).trim();
      const existing = await this.revParse(`refs/tags/${tag}^{commit}`);
      if (existing !== undefined) {
        const tagged = await this.revParse(`refs/tags/${tag}^{tree}`);
        if (tagged !== tree) {
          throw new Error(
            `Tag ${tag} in ${this.slug} holds other files than version ${String(version)}.`,
          );
        }
        await this.git(["push", "-q", "origin", `refs/tags/${tag}`]);
        return existing;
      }
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
      const sha = (await this.git(["rev-parse", "HEAD"])).trim();
      await this.git(["tag", tag, sha]);
      await this.git(["push", "-q", "origin", `${sha}:refs/heads/main`, `refs/tags/${tag}`]);
      return sha;
    });
  }

  private revParse(ref: string): Promise<string | undefined> {
    return this.git(["rev-parse", "--verify", "-q", ref])
      .then((sha) => sha.trim())
      .catch(() => undefined);
  }

  private async ensureClone(): Promise<void> {
    if (!existsSync(join(this.dir, ".git"))) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      await this.git(["init", "-q", "-b", "main"]);
      await this.git(["remote", "add", "origin", this.url]);
    }
    await this.git(["remote", "set-url", "origin", this.url]);
    // An empty new repo has nothing to fetch.
    await this.git(["fetch", "-q", "--force", "--tags", "origin"]).catch(() => undefined);
    const remoteMain = await this.revParse("refs/remotes/origin/main");
    if (remoteMain !== undefined) await this.git(["reset", "-q", "--hard", remoteMain]);
  }

  private git(args: string[]): Promise<string> {
    return this.exec(
      this.gitPath,
      [
        "-c",
        "credential.helper=",
        "-c",
        `credential.https://github.com.helper=!${this.ghPath} auth git-credential`,
        ...args,
      ],
      this.dir,
    );
  }
}
