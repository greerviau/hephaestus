import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BASELINE_TARGETS,
  diffBaselines,
  readBaseline,
  resolveRoots,
  takeBaseline,
} from "../src/baseline.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hephaestus-baseline-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function write(relativePath: string, content: string): void {
  const path = join(home, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

describe("takeBaseline", () => {
  it("covers the personal Hermes profile, Claude and Codex config, and T3 settings", () => {
    const groups = new Set(BASELINE_TARGETS.map((target) => target.group));
    expect([...groups]).toEqual(["hermes", "claude", "codex", "t3"]);
  });

  it("records a hash for each file and marks missing targets as absent", () => {
    write(".hermes/config.yaml", "model: x\n");
    write(".claude/skills/review/SKILL.md", "# review\n");

    const baseline = takeBaseline(home);

    expect(baseline.entries[".hermes/config.yaml"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(baseline.entries[".claude/skills/review/SKILL.md"]).toMatch(/^sha256:/);
    expect(baseline.entries[".codex/config.toml"]).toBe("absent");
  });

  it("records a broken symlink's target", () => {
    mkdirSync(join(home, ".claude/skills"), { recursive: true });
    symlinkSync("/nowhere/review", join(home, ".claude/skills/review"));

    const baseline = takeBaseline(home);

    expect(baseline.entries[".claude/skills/review"]).toBe("symlink:/nowhere/review");
  });

  it("follows a linked skill directory, so edits inside it count as drift", () => {
    const outside = mkdtempSync(join(tmpdir(), "hephaestus-linked-"));
    try {
      writeFileSync(join(outside, "SKILL.md"), "# v1\n");
      mkdirSync(join(home, ".claude/skills"), { recursive: true });
      symlinkSync(outside, join(home, ".claude/skills/review"));
      const before = takeBaseline(home);

      expect(before.entries[".claude/skills/review"]).toBe(`symlink:${outside}`);
      expect(before.entries[".claude/skills/review/SKILL.md"]).toMatch(/^sha256:/);

      writeFileSync(join(outside, "SKILL.md"), "# v2\n");
      const drift = diffBaselines(before, takeBaseline(home));

      expect(drift.map((change) => change.path)).toEqual([".claude/skills/review/SKILL.md"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("records a linked file's target and content", () => {
    write("shared/CLAUDE.md", "# shared\n");
    mkdirSync(join(home, ".claude"), { recursive: true });
    symlinkSync(join(home, "shared/CLAUDE.md"), join(home, ".claude/CLAUDE.md"));

    const entry = takeBaseline(home).entries[".claude/CLAUDE.md"];

    expect(entry).toMatch(/^symlink:.+ sha256:[0-9a-f]{64}$/);
  });

  it("stops at a symlink cycle", () => {
    mkdirSync(join(home, ".claude/skills/a"), { recursive: true });
    symlinkSync(join(home, ".claude/skills"), join(home, ".claude/skills/a/loop"));

    const baseline = takeBaseline(home);

    expect(baseline.entries[".claude/skills/a/loop"]).toBe(
      `symlink:${join(home, ".claude/skills")}`,
    );
    expect(Object.keys(baseline.entries).some((key) => key.includes("loop/a"))).toBe(false);
  });

  it("records both links when two skill folders link to the same checkout", () => {
    write("checkout/review/SKILL.md", "# review\n");
    mkdirSync(join(home, ".claude/skills"), { recursive: true });
    mkdirSync(join(home, ".agents/skills"), { recursive: true });
    symlinkSync(join(home, "checkout/review"), join(home, ".claude/skills/review"));
    symlinkSync(join(home, "checkout/review"), join(home, ".agents/skills/review"));

    const entries = takeBaseline(home).entries;

    expect(entries[".claude/skills/review/SKILL.md"]).toMatch(/^sha256:/);
    expect(entries[".agents/skills/review/SKILL.md"]).toMatch(/^sha256:/);
  });

  it("uses config roots set by HERMES_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and T3CODE_HOME", () => {
    write("custom/hermes/config.yaml", "model: x\n");
    write("custom/claude/CLAUDE.md", "# x\n");
    write("custom/codex/config.toml", "x = 1\n");
    write("custom/t3/userdata/settings.json", "{}\n");
    const roots = resolveRoots(
      {
        HERMES_HOME: join(home, "custom/hermes"),
        CLAUDE_CONFIG_DIR: join(home, "custom/claude"),
        CODEX_HOME: join(home, "custom/codex"),
        T3CODE_HOME: join(home, "custom/t3"),
      },
      home,
    );

    const baseline = takeBaseline(home, roots);

    expect(baseline.roots).toEqual(roots);
    expect(baseline.entries["custom/hermes/config.yaml"]).toMatch(/^sha256:/);
    expect(baseline.entries["custom/claude/CLAUDE.md"]).toMatch(/^sha256:/);
    expect(baseline.entries["custom/codex/config.toml"]).toMatch(/^sha256:/);
    expect(baseline.entries["custom/t3/userdata/settings.json"]).toMatch(/^sha256:/);
  });

  it("covers named personal Hermes profiles", () => {
    write(".hermes/profiles/work/config.yaml", "model: work\n");
    write(".hermes/profiles/work/sessions/s1.json", "{}\n");

    const baseline = takeBaseline(home);

    expect(baseline.entries[".hermes/profiles/work/config.yaml"]).toMatch(/^sha256:/);
    expect(baseline.entries[".hermes/profiles/work/sessions/s1.json"]).toBeUndefined();
  });

  it("records a file it cannot read instead of failing", () => {
    write(".claude/CLAUDE.md", "# x\n");
    chmodSync(join(home, ".claude/CLAUDE.md"), 0o000);
    try {
      expect(takeBaseline(home).entries[".claude/CLAUDE.md"]).toBe("unreadable:EACCES");
    } finally {
      chmodSync(join(home, ".claude/CLAUDE.md"), 0o600);
    }
  });

  it("records a folder it cannot list instead of failing", () => {
    write(".claude/skills/locked/SKILL.md", "# x\n");
    chmodSync(join(home, ".claude/skills/locked"), 0o000);
    try {
      expect(takeBaseline(home).entries[".claude/skills/locked"]).toBe("unreadable:EACCES");
    } finally {
      chmodSync(join(home, ".claude/skills/locked"), 0o700);
    }
  });

  it("covers Codex instruction overrides and rules", () => {
    write(".codex/AGENTS.override.md", "# override\n");
    write(".codex/rules/default.rules", "rule\n");

    const entries = takeBaseline(home).entries;

    expect(entries[".codex/AGENTS.override.md"]).toMatch(/^sha256:/);
    expect(entries[".codex/rules/default.rules"]).toMatch(/^sha256:/);
  });

  it("keeps a backslash in a file name distinct from a folder separator", () => {
    write(".claude/skills/sample\\SKILL.md", "flat\n");
    write(".claude/skills/sample/SKILL.md", "nested\n");

    const entries = takeBaseline(home).entries;
    const flat = entries[".claude/skills/sample\\SKILL.md"];
    const nested = entries[".claude/skills/sample/SKILL.md"];

    expect(flat).toMatch(/^sha256:/);
    expect(nested).toMatch(/^sha256:/);
    expect(flat).not.toBe(nested);
  });

  it("treats a target under a regular file as absent", () => {
    write(".hermes", "not a directory\n");

    expect(takeBaseline(home).entries[".hermes/config.yaml"]).toBe("absent");
  });

  it("ignores volatile files that are not listed as targets", () => {
    write(".hermes/logs/gateway.log", "noise\n");
    write(".claude/history.jsonl", "{}\n");

    const baseline = takeBaseline(home);

    expect(Object.keys(baseline.entries).some((key) => key.includes("logs"))).toBe(false);
    expect(baseline.entries[".claude/history.jsonl"]).toBeUndefined();
  });
});

describe("diffBaselines", () => {
  it("reports changed, added and removed entries and nothing for an unchanged home", () => {
    write(".hermes/SOUL.md", "before\n");
    write(".claude/CLAUDE.md", "keep\n");
    write(".codex/AGENTS.md", "remove me\n");
    const before = takeBaseline(home);

    expect(diffBaselines(before, takeBaseline(home))).toEqual([]);

    write(".hermes/SOUL.md", "after\n");
    write(".agents/skills/new/SKILL.md", "# new\n");
    rmSync(join(home, ".codex/AGENTS.md"));
    const drift = diffBaselines(before, takeBaseline(home));

    expect(drift.map((change) => change.path)).toEqual([
      ".agents/skills/new/SKILL.md",
      ".codex/AGENTS.md",
      ".hermes/SOUL.md",
    ]);
    expect(drift.find((change) => change.path === ".codex/AGENTS.md")?.after).toBe("absent");
    expect(drift.find((change) => change.path === ".agents/skills/new/SKILL.md")?.before).toBe(
      "absent",
    );
  });
});

describe("readBaseline", () => {
  it.each([
    ["not JSON", "{"],
    ["entries as a list", '{"takenAt":"x","roots":{},"entries":[]}'],
    ["a non-string entry", '{"takenAt":"x","roots":{},"entries":{"a":1}}'],
    ["no roots", '{"takenAt":"x","entries":{}}'],
  ])("rejects %s", (_label, content) => {
    write("baseline.json", content);

    expect(readBaseline(join(home, "baseline.json"))).toBeUndefined();
  });

  it("reads a baseline it wrote", () => {
    write(".claude/CLAUDE.md", "# x\n");
    const baseline = takeBaseline(home);
    write("baseline.json", JSON.stringify(baseline));

    expect(readBaseline(join(home, "baseline.json"))).toEqual(baseline);
  });
});
