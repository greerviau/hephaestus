import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BASELINE_TARGETS, diffBaselines, takeBaseline } from "../src/baseline.js";

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
    const groups = BASELINE_TARGETS.map((target) => target.group);
    expect(groups).toEqual(["hermes", "claude", "codex", "t3"]);
  });

  it("records a hash for each file and marks missing targets as absent", () => {
    write(".hermes/config.yaml", "model: x\n");
    write(".claude/skills/review/SKILL.md", "# review\n");

    const baseline = takeBaseline(home);

    expect(baseline.entries[".hermes/config.yaml"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(baseline.entries[".claude/skills/review/SKILL.md"]).toMatch(/^sha256:/);
    expect(baseline.entries[".codex/config.toml"]).toBe("absent");
  });

  it("records a symlink's target without following it", () => {
    mkdirSync(join(home, ".claude/skills"), { recursive: true });
    symlinkSync("/nowhere/review", join(home, ".claude/skills/review"));

    const baseline = takeBaseline(home);

    expect(baseline.entries[".claude/skills/review"]).toBe("symlink:/nowhere/review");
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
