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
    const repo = new ConfigRepo(join(dir, "clone"), "octo/config", "git", "true", exec);

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
    expect(tagged("v1")).toBe(first);
    expect(tagged("v2")).toBe(second);
    expect(
      execFileSync("git", ["-C", remote, "show", "v2:claude/CLAUDE.md"], { encoding: "utf8" }),
    ).toBe("# Changed\n");
  });

  it("creates the private repo only when gh cannot find it", async () => {
    const calls: string[][] = [];
    const exec: CommandRun = (_file, args) => {
      calls.push(args);
      if (args[0] === "repo" && args[1] === "view") return Promise.reject(new Error("not found"));
      return Promise.resolve("");
    };
    await new ConfigRepo(dir, "octo/config", "git", "gh", exec).ensureRemote();
    expect(calls[1]?.slice(0, 4)).toEqual(["repo", "create", "octo/config", "--private"]);
  });

  it("refuses a name that is not owner/repo", () => {
    expect(() => new ConfigRepo(dir, "octo/config; rm", "git", "gh")).toThrow(/owner\/repo/);
  });
});
