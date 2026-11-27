import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigRepo,
  commandRunner,
  versionFiles,
  type CommandRun,
} from "../../src/workers/config-repo.js";
import { sampleConfig } from "../config/fixtures.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hephaestus-config-repo-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("versionFiles", () => {
  it("puts the factory instructions and thread skills under claude/ and codex/", () => {
    const config = sampleConfig();
    config.factory.threadSkills = ["triage"];
    expect(versionFiles(3, config)).toEqual({
      VERSION: "3\n",
      "claude/CLAUDE.md": "# Factory instructions\n",
      "codex/AGENTS.md": "# Factory instructions\n",
      "claude/skills/triage/SKILL.md": "# Triage\n",
      "codex/skills/triage/SKILL.md": "# Triage\n",
    });
  });

  it("leaves out the coding thread instructions earlier builds shipped, and keeps the owner's", () => {
    const config = sampleConfig();
    // What install copied into version 1, with one rule the owner added to the list.
    config.instructions.factory = `# Factory thread instructions

You are working in a factory thread started by Hephaestus. Nobody watches this thread while it runs.

- Do the task in the brief, and only that task.
- Follow the repository's own contribution rules, tests, and checks.
- Before you push, run the repository's full set of checks.
- Do not merge pull requests. Hephaestus merges them.
- If you cannot finish, say what blocked you instead of guessing.

End your final message with a result block that Hephaestus reads:

\`\`\`hephaestus-result
{"status": "done", "pr": 123, "headSha": "<full commit SHA>"}
\`\`\`

Use \`"status": "blocked"\` with a \`"reason"\` when you could not finish. A reviewer reports \`"verdict": "approve"\` or \`"verdict": "changes"\` and the \`"headSha"\` it reviewed.
`;
    const files = versionFiles(3, config);
    expect(files["claude/CLAUDE.md"]).toBe(
      "- Before you push, run the repository's full set of checks.\n",
    );
    expect(files["codex/AGENTS.md"]).toBe(files["claude/CLAUDE.md"]);

    // The old result block is a copy even when the owner typed a rule straight under it.
    config.instructions.factory =
      '```hephaestus-result\n{"status": "done", "pr": 123, "headSha": "<full commit SHA>"}\n```\n- Keep PRs small.\n';
    expect(versionFiles(3, config)["claude/CLAUDE.md"]).toBe("- Keep PRs small.\n");

    // A copy that lost its code marks is still a copy.
    config.instructions.factory =
      'Use "status": "blocked" with a "reason" when you could not finish. A reviewer reports "verdict": "approve" or "verdict": "changes" and the "headSha" it reviewed.\n';
    expect(versionFiles(3, config)["claude/CLAUDE.md"]).toBe("");

    config.instructions.factory = "# Factory thread instructions\n";
    expect(versionFiles(3, config)["claude/CLAUDE.md"]).toBe("");
  });
});

describe("commandRunner", () => {
  it("writes the input to the command's stdin, byte for byte, however large", async () => {
    // Bytes that are not valid text, and more than a pipe holds, so a short or lossy write shows.
    const bytes = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 256;
    const payload = JSON.stringify({ message: "Attach b.png", content: bytes.toString("base64") });
    const echoed = await commandRunner("cat", ["-"], undefined, undefined, payload);
    expect(echoed).toBe(payload);
    expect(
      Buffer.from((JSON.parse(echoed) as { content: string }).content, "base64").equals(bytes),
    ).toBe(true);
  });

  it("leaves stdin empty when there is no input, and still reports a command's failure", async () => {
    expect(await commandRunner("cat", ["-"])).toBe("");
    await expect(
      commandRunner("sh", ["-c", "cat >/dev/null; echo no >&2; exit 3"], undefined, undefined, "x"),
    ).rejects.toThrow(/failed: no/);
    // A command that exits without reading its input must not turn into a write error.
    await expect(
      commandRunner("true", [], undefined, undefined, "x".repeat(1 << 20)),
    ).resolves.toBe("");
  });
});

describe("ConfigRepo", () => {
  it("commits, tags, and pushes each version, and returns the same commit for a version published twice", async () => {
    const remote = join(dir, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    // Point the https URL at the local bare repo, and skip gh.
    const exec: CommandRun = (file, args, cwd) =>
      commandRunner(
        file,
        args.map((arg) => (arg === "https://github.com/octo/config.git" ? remote : arg)),
        cwd,
      );
    const repo = new ConfigRepo(join(dir, "clone"), "octo/config", "git", "true", "abc-", exec);

    const first = await repo.publish(1, sampleConfig());
    const config = sampleConfig();
    config.instructions.factory = "# Changed\n";
    const second = await repo.publish(2, config);
    const again = await repo.publish(1, sampleConfig());

    expect(again).toBe(first);
    expect(second).not.toBe(first);
    const tagged = (tag: string): string =>
      execFileSync("git", ["-C", remote, "rev-parse", `${tag}^{commit}`], {
        encoding: "utf8",
      }).trim();
    expect(tagged("abc-v1")).toBe(first);
    expect(tagged("abc-v2")).toBe(second);
    expect(
      execFileSync("git", ["-C", remote, "show", "abc-v2:claude/CLAUDE.md"], { encoding: "utf8" }),
    ).toBe("# Changed\n");
  });

  it("commits a skill file that the skill's own .gitignore matches", async () => {
    const remote = join(dir, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    const exec: CommandRun = (file, args, cwd) =>
      commandRunner(
        file,
        args.map((arg) => (arg === "https://github.com/octo/config.git" ? remote : arg)),
        cwd,
      );
    const config = sampleConfig();
    config.skills.triage = { "SKILL.md": "# Triage\n", ".gitignore": "*.txt\n", "notes.txt": "x" };
    config.factory.threadSkills = ["triage"];
    const sha = await new ConfigRepo(
      join(dir, "clone"),
      "octo/config",
      "git",
      "true",
      "p-",
      exec,
    ).publish(1, config);
    expect(
      execFileSync("git", ["-C", remote, "show", `${sha}:codex/skills/triage/notes.txt`], {
        encoding: "utf8",
      }),
    ).toBe("x");
  });

  it("refuses a version whose tag already holds other files", async () => {
    const remote = join(dir, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    const exec: CommandRun = (file, args, cwd) =>
      commandRunner(
        file,
        args.map((arg) => (arg === "https://github.com/octo/config.git" ? remote : arg)),
        cwd,
      );
    const repo = new ConfigRepo(join(dir, "clone"), "octo/config", "git", "true", "abc-", exec);
    await repo.publish(1, sampleConfig());
    const changed = sampleConfig();
    changed.instructions.factory = "# Other\n";

    await expect(repo.publish(1, changed)).rejects.toThrow(/holds other files/);
  });

  it("tags each of two concurrent publishes with its own commit", async () => {
    const remote = join(dir, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    const exec: CommandRun = (file, args, cwd) =>
      commandRunner(
        file,
        args.map((arg) => (arg === "https://github.com/octo/config.git" ? remote : arg)),
        cwd,
      );
    const clone = join(dir, "clone");
    const second = sampleConfig();
    second.instructions.factory = "# Two\n";
    const [a, b] = await Promise.all([
      new ConfigRepo(clone, "octo/config", "git", "true", "p-", exec).publish(1, sampleConfig()),
      new ConfigRepo(clone, "octo/config", "git", "true", "p-", exec).publish(2, second),
    ]);
    const show = (ref: string): string =>
      execFileSync("git", ["-C", remote, "show", ref], { encoding: "utf8" });
    expect(show(`${a}:VERSION`)).toBe("1\n");
    expect(show(`${b}:VERSION`)).toBe("2\n");
    expect(show("p-v2:VERSION")).toBe("2\n");
  });

  it("creates the private repo only when GitHub says it does not exist", async () => {
    const calls: string[][] = [];
    const exec: CommandRun = (_file, args) => {
      calls.push(args);
      if (args[0] === "repo" && args[1] === "view") {
        return Promise.reject(
          new Error("GraphQL: Could not resolve to a Repository with the name"),
        );
      }
      return Promise.resolve("");
    };
    await new ConfigRepo(dir, "octo/config", "git", "gh", "", exec).ensureRemote();
    expect(calls[1]?.slice(0, 4)).toEqual(["repo", "create", "octo/config", "--private"]);
  });

  it("refuses a public repo and does not create one after another gh error", async () => {
    const publicRepo: CommandRun = () => Promise.resolve('{"isPrivate":false}');
    await expect(
      new ConfigRepo(dir, "octo/config", "git", "gh", "", publicRepo).ensureRemote(),
    ).rejects.toThrow(/not a private repo/);
    const calls: string[][] = [];
    const offline: CommandRun = (_file, args) => {
      calls.push(args);
      return Promise.reject(new Error("error connecting to api.github.com"));
    };
    await expect(
      new ConfigRepo(dir, "octo/config", "git", "gh", "", offline).ensureRemote(),
    ).rejects.toThrow(/connecting/);
    expect(calls).toHaveLength(1);
  });

  it("refuses a name that is not owner/repo", () => {
    expect(() => new ConfigRepo(dir, "octo/config; rm", "git", "gh", "")).toThrow(/owner\/repo/);
  });
});
