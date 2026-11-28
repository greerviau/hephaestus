import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeSignInMessage,
  cleanupMessage,
  deployMessage,
  limitText,
  parseDeploy,
  parseDeviceCode,
} from "../../src/workers/scripts.js";

const SHA = "c".repeat(40);

describe("parseDeploy", () => {
  it("reads the DEPLOYED line", () => {
    expect(
      parseDeploy(
        `\`\`\`\nDEPLOYED version=4 head=${SHA} home=/home/w instances=unchanged\n\`\`\``,
      ),
    ).toEqual({
      version: 4,
      head: SHA,
      home: "/home/w",
      instances: "unchanged",
    });
  });

  it("reports the script's failure, or a missing result", () => {
    expect(parseDeploy("DEPLOY-FAILED tag v4 is x, expected y")).toEqual({
      failure: "tag v4 is x, expected y",
    });
    expect(parseDeploy("I could not run that.")).toEqual({
      failure: "the deploy thread did not report a result",
    });
  });
});

describe("parseDeviceCode", () => {
  it("finds the link and code in a command's output, not in the command itself", () => {
    expect(
      parseDeviceCode([
        {
          itemId: "a",
          position: 1,
          type: "command_execution",
          status: "completed",
          text: "$ sed ... | grep -E 'https://|^ +[A-Z0-9]{4}-[A-Z0-9]{4,}'\n   https://auth.openai.com/codex/device\n   2UY4-4HUKL",
        },
      ]),
    ).toEqual({ url: "https://auth.openai.com/codex/device", code: "2UY4-4HUKL" });
  });
});

/** Extracts the fenced script from a thread message, as the agent would save it. */
function scriptOf(message: string): string {
  const match = /```bash\n([\s\S]*?)```/.exec(message);
  if (match?.[1] === undefined) throw new Error("no script");
  return match[1];
}

describe("worker scripts", () => {
  let home: string;
  let remote: string;
  let sha: string;
  /** Holds a getent that names `home` as the account's home folder, as the real one would. */
  let account: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hephaestus-worker-"));
    remote = join(home, "remote");
    mkdirSync(join(remote, "claude/skills/probe"), { recursive: true });
    mkdirSync(join(remote, "codex/skills/probe"), { recursive: true });
    writeFileSync(join(remote, "claude/CLAUDE.md"), "# Factory\n");
    writeFileSync(join(remote, "codex/AGENTS.md"), "# Factory\n");
    writeFileSync(join(remote, "claude/skills/probe/SKILL.md"), "# Probe\n");
    writeFileSync(join(remote, "codex/skills/probe/SKILL.md"), "# Probe\n");
    writeFileSync(join(remote, "VERSION"), "1\n");
    const git = (...args: string[]): string =>
      execFileSync("git", ["-C", remote, ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "v1");
    git("tag", "p-v1");
    sha = git("rev-parse", "HEAD");
    mkdirSync(join(home, ".t3/userdata"), { recursive: true });
    writeFileSync(join(home, ".t3/userdata/settings.json"), JSON.stringify({ theme: "dark" }));
    mkdirSync(join(home, ".agents/skills/tdd"), { recursive: true });
    writeFileSync(join(home, ".agents/skills/tdd/SKILL.md"), "# TDD\n");
    account = join(home, "account-bin");
    mkdirSync(account);
    passwdHome(home);
  });

  function passwdHome(path: string): void {
    writeFileSync(
      join(account, "getent"),
      `#!/bin/sh\necho "owner:x:1000:1000::${path}:/bin/bash"\n`,
      { mode: 0o755 },
    );
  }

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function run(script: string, ...args: string[]): string {
    const path = join(home, "script.sh");
    writeFileSync(path, script);
    try {
      return execFileSync("bash", [path, ...args], {
        encoding: "utf8",
        env: { PATH: `${account}:${process.env.PATH ?? ""}`, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string };
      throw new Error(`script failed: ${failed.stdout ?? ""}${failed.stderr ?? ""}`, {
        cause: error,
      });
    }
  }

  it("deploy.sh installs the version and the instances, and a second run changes nothing", () => {
    const script = scriptOf(deployMessage(1, sha, remote, "p-v1"));
    expect(run(script, "1", sha, remote, "p-v1").trim()).toBe(
      `DEPLOYED version=1 head=${sha} home=${home} instances=wrote`,
    );
    expect(run(script, "1", sha, remote, "p-v1")).toContain("instances=unchanged");

    const settings = JSON.parse(readFileSync(join(home, ".t3/userdata/settings.json"), "utf8")) as {
      theme: string;
      providerInstances: Record<string, { config: { homePath: string } }>;
    };
    expect(settings.theme).toBe("dark");
    expect(settings.providerInstances["hephaestus-claude"]?.config.homePath).toBe(
      join(home, ".hephaestus/claude"),
    );
    expect(readFileSync(join(home, ".hephaestus/claude/CLAUDE.md"), "utf8")).toBe("# Factory\n");
    expect(readFileSync(join(home, ".hephaestus/codex/skills/probe/SKILL.md"), "utf8")).toBe(
      "# Probe\n",
    );
    expect(readFileSync(join(home, ".hephaestus/codex/config.toml"), "utf8")).toContain(
      `path = "${join(home, ".agents/skills/tdd/SKILL.md")}"\nenabled = false`,
    );
    expect(readFileSync(join(home, ".hephaestus/claude/settings.json"), "utf8")).toContain(
      join(home, ".claude/CLAUDE.md"),
    );
  });

  it("deploy.sh installs files that .gitattributes marks export-ignore, and disables nested owner skills", () => {
    writeFileSync(join(remote, ".gitattributes"), "claude/skills/probe/SKILL.md export-ignore\n");
    execFileSync("git", ["-C", remote, "add", "-A"]);
    execFileSync("git", [
      "-C",
      remote,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "attrs",
    ]);
    execFileSync("git", ["-C", remote, "tag", "-f", "p-v1"]);
    const head = execFileSync("git", ["-C", remote, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    mkdirSync(join(home, ".agents/skills/group/deep"), { recursive: true });
    writeFileSync(join(home, ".agents/skills/group/deep/SKILL.md"), "# Deep\n");

    run(scriptOf(deployMessage(1, head, remote, "p-v1")), "1", head, remote, "p-v1");

    expect(readFileSync(join(home, ".hephaestus/claude/skills/probe/SKILL.md"), "utf8")).toBe(
      "# Probe\n",
    );
    expect(readFileSync(join(home, ".hephaestus/codex/config.toml"), "utf8")).toContain(
      join(home, ".agents/skills/group/deep/SKILL.md"),
    );
  });

  it("deploy.sh makes each new worktree of a project hold that project's skills and no other's", () => {
    const git = (dir: string, ...args: string[]): string =>
      execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home },
      }).trim();
    mkdirSync(join(remote, "projects/octo__app/skills/migrations"), { recursive: true });
    writeFileSync(join(remote, "projects/octo__app/skills/migrations/SKILL.md"), "# Migrations\n");
    git(remote, "add", "-A");
    git(remote, "commit", "-qm", "project skills");
    git(remote, "tag", "-f", "p-v1");
    const head = git(remote, "rev-parse", "HEAD");
    // The factory clones T3 made of two projects; the first keeps GitHub's casing.
    const clones = { app: "Octo__App", lib: "octo__lib" };
    for (const name of Object.values(clones)) {
      const clone = join(home, ".hephaestus/projects", name);
      mkdirSync(join(clone, ".claude/skills/own"), { recursive: true });
      writeFileSync(join(clone, ".claude/skills/own/SKILL.md"), "# Own\n");
      git(clone, "init", "-q", "-b", "main");
      git(clone, "add", "-A");
      git(clone, "commit", "-qm", "init");
    }

    run(scriptOf(deployMessage(1, head, remote, "p-v1")), "1", head, remote, "p-v1");
    const worktree = (name: string): string => {
      const path = join(home, ".t3/worktrees", name, "task-1");
      git(join(home, ".hephaestus/projects", name), "worktree", "add", "-q", "-b", "task-1", path);
      return path;
    };
    const app = worktree(clones.app);
    const lib = worktree(clones.lib);

    for (const dir of [".claude/skills", ".agents/skills"]) {
      expect(readFileSync(join(app, dir, "migrations/SKILL.md"), "utf8")).toBe("# Migrations\n");
      expect(existsSync(join(lib, dir, "migrations"))).toBe(false);
    }
    expect(readFileSync(join(app, ".claude/skills/own/SKILL.md"), "utf8")).toBe("# Own\n");
    // The links stay out of what the thread commits.
    expect(git(app, "status", "--porcelain")).toBe("");
  });

  it("cleanup.sh fails and keeps ~/.hephaestus when the factory Codex logout fails", () => {
    run(scriptOf(deployMessage(1, sha, remote, "p-v1")), "1", sha, remote, "p-v1");
    writeFileSync(join(home, ".hephaestus/codex/auth.json"), "{}");
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const path = join(home, "cleanup.sh");
    writeFileSync(path, scriptOf(cleanupMessage()));
    let output = "";
    try {
      execFileSync("bash", [path], {
        encoding: "utf8",
        env: { PATH: `${bin}:${account}:${process.env.PATH ?? ""}`, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      output = (error as { stdout?: string }).stdout ?? "";
    }
    expect(output).toMatch(/^CLEANUP-FAILED codex logout failed/m);
    expect(readFileSync(join(home, ".hephaestus/codex/auth.json"), "utf8")).toBe("{}");
  });

  /** Runs a script as an agent testing it under a scratch HOME would, with T3's own T3CODE_HOME. */
  function runSplit(script: string, ...args: string[]): string {
    const path = join(home, "split.sh");
    writeFileSync(path, script);
    try {
      return execFileSync("bash", [path, ...args], {
        encoding: "utf8",
        env: {
          PATH: `${account}:${process.env.PATH ?? ""}`,
          HOME: home,
          T3CODE_HOME: join(home, ".t3"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return (error as { stdout?: string }).stdout ?? "";
    }
  }

  const settingsText = (): string => readFileSync(join(home, ".t3/userdata/settings.json"), "utf8");

  it("deploy.sh changes nothing when HOME is not the account's home folder", () => {
    passwdHome(join(tmpdir(), "the-real-home"));
    const output = runSplit(
      scriptOf(deployMessage(1, sha, remote, "p-v1")),
      "1",
      sha,
      remote,
      "p-v1",
    );

    expect(output).toMatch(/^DEPLOY-FAILED HOME is .+, not this account's home folder/m);
    expect(settingsText()).toBe(JSON.stringify({ theme: "dark" }));
    expect(existsSync(join(home, ".hephaestus"))).toBe(false);
  });

  it("deploy.sh and cleanup.sh report an unset HOME", () => {
    for (const [script, marker] of [
      [scriptOf(deployMessage(1, sha, remote, "p-v1")), "DEPLOY-FAILED"],
      [scriptOf(cleanupMessage()), "CLEANUP-FAILED"],
    ] as const) {
      const path = join(home, "no-home.sh");
      writeFileSync(path, script);
      let output = "";
      try {
        execFileSync("bash", [path, "1", sha, remote, "p-v1"], {
          encoding: "utf8",
          env: { PATH: `${account}:${process.env.PATH ?? ""}` },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        output = (error as { stdout?: string }).stdout ?? "";
      }
      expect(output).toMatch(new RegExp(`^${marker} HOME is unset`, "m"));
    }
  });

  it("deploy.sh reports a failed lookup of the account's home folder", () => {
    writeFileSync(join(account, "getent"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    const output = runSplit(
      scriptOf(deployMessage(1, sha, remote, "p-v1")),
      "1",
      sha,
      remote,
      "p-v1",
    );

    expect(output).toMatch(/^DEPLOY-FAILED .*account's home folder/m);
    expect(settingsText()).toBe(JSON.stringify({ theme: "dark" }));
  });

  it("deploy.sh accepts the account's home folder written with a trailing slash", () => {
    passwdHome(`${home}/`);
    expect(
      run(scriptOf(deployMessage(1, sha, remote, "p-v1")), "1", sha, remote, "p-v1"),
    ).toContain("DEPLOYED version=1");
  });

  it("cleanup.sh changes nothing when HOME is not the account's home folder", () => {
    run(scriptOf(deployMessage(1, sha, remote, "p-v1")), "1", sha, remote, "p-v1");
    const before = settingsText();
    passwdHome(join(tmpdir(), "the-real-home"));
    const output = runSplit(scriptOf(cleanupMessage()));

    expect(output).toMatch(/^CLEANUP-FAILED HOME is .+, not this account's home folder/m);
    expect(settingsText()).toBe(before);
    expect(existsSync(join(home, ".hephaestus"))).toBe(true);
  });

  it("deploy.sh stops when the tag points at another commit", () => {
    const script = scriptOf(deployMessage(1, "d".repeat(40), remote, "p-v1"));
    expect(() => run(script, "1", "d".repeat(40), remote, "p-v1")).toThrow(/DEPLOY-FAILED tag/);
  });

  it("deploy.sh stops when the tagged commit holds another version", () => {
    const script = scriptOf(deployMessage(2, sha, remote, "p-v1"));
    expect(() => run(script, "2", sha, remote, "p-v1")).toThrow(/holds version 1, expected 2/);
  });

  it("deploy.sh refuses to replace a real folder at a skill's path", () => {
    mkdirSync(join(home, ".hephaestus/codex/skills/probe"), { recursive: true });
    const script = scriptOf(deployMessage(1, sha, remote, "p-v1"));
    expect(() => run(script, "1", sha, remote, "p-v1")).toThrow(/is a real folder/);
  });

  it("set-claude-token.sh strips line breaks and keeps the rest of the settings", () => {
    run(scriptOf(deployMessage(1, sha, remote, "p-v1")), "1", sha, remote, "p-v1");
    const secret = join(home, "secret");
    writeFileSync(secret, "sk-ant-oat01-abc\n  def\n");
    const script = /```bash\n([\s\S]*?)```/.exec(claudeSignInMessage())?.[1] ?? "";
    expect(run(script, secret).trim()).toBe("TOKEN-SET length=19");
    const settings = JSON.parse(readFileSync(join(home, ".t3/userdata/settings.json"), "utf8")) as {
      theme: string;
      providerInstances: Record<string, { environment?: { name: string; value: string }[] }>;
    };
    expect(settings.theme).toBe("dark");
    expect(settings.providerInstances["hephaestus-claude"]?.environment).toEqual([
      { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-abcdef", sensitive: true },
    ]);
  });

  it("cleanup.sh fails and keeps ~/.hephaestus when T3's settings cannot be read", () => {
    run(scriptOf(deployMessage(1, sha, remote, "p-v1")), "1", sha, remote, "p-v1");
    writeFileSync(join(home, ".t3/userdata/settings.json"), "{ not json");
    expect(() => run(scriptOf(cleanupMessage()))).toThrow();
    expect(readFileSync(join(home, ".hephaestus/claude/CLAUDE.md"), "utf8")).toBe("# Factory\n");
  });

  it("cleanup.sh removes the instances and ~/.hephaestus and keeps the owner's settings", () => {
    run(scriptOf(deployMessage(1, sha, remote, "p-v1")), "1", sha, remote, "p-v1");
    expect(run(scriptOf(cleanupMessage())).trim()).toBe(
      "CLEANED instances=hephaestus-claude,hephaestus-codex hephaestus=removed",
    );
    expect(JSON.parse(readFileSync(join(home, ".t3/userdata/settings.json"), "utf8"))).toEqual({
      theme: "dark",
    });
  });
});

describe("limitText", () => {
  it.each([
    "You've hit your usage limit. Try again at 8:02 AM.",
    "You've hit your limit · resets 8pm (Africa/Cairo)",
    "You've hit your session limit · resets 1:50am (Asia/Tokyo)",
    "5-hour limit reached ∙ resets 3pm",
    "429 Too Many Requests",
  ])("reads %j as a limit", (text) => {
    expect(limitText(text)).toBeDefined();
  });

  it.each(["Not logged in", "Invalid API key · Please run /login", "OAuth token has expired"])(
    "does not read %j as a limit",
    (text) => {
      expect(limitText(text)).toBeUndefined();
    },
  );
});
