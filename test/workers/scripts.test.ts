import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeSignInMessage,
  cleanupMessage,
  deployMessage,
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
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function run(script: string, ...args: string[]): string {
    const path = join(home, "script.sh");
    writeFileSync(path, script);
    try {
      return execFileSync("bash", [path, ...args], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home },
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

  it("cleanup.sh fails and keeps ~/.hephaestus when the factory Codex logout fails", () => {
    run(scriptOf(deployMessage(1, sha, remote, "p-v1")), "1", sha, remote, "p-v1");
    writeFileSync(join(home, ".hephaestus/codex/auth.json"), "{}");
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const path = join(home, "cleanup.sh");
    writeFileSync(path, scriptOf(cleanupMessage()));
    expect(() =>
      execFileSync("bash", [path], {
        encoding: "utf8",
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).toThrow();
    expect(readFileSync(join(home, ".hephaestus/codex/auth.json"), "utf8")).toBe("{}");
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
