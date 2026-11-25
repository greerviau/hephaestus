import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Owner-authored config that Hephaestus must leave unchanged, as paths relative
 * to the home directory. Credentials and runtime state are left out because
 * they change during normal use.
 */
export const BASELINE_TARGETS = [
  {
    group: "hermes",
    paths: [
      ".hermes/config.yaml",
      ".hermes/.env",
      ".hermes/SOUL.md",
      ".hermes/skills",
      ".hermes/hooks",
    ],
  },
  {
    group: "claude",
    paths: [
      ".claude/CLAUDE.md",
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".claude/skills",
      ".claude/agents",
      ".claude/commands",
    ],
  },
  {
    group: "codex",
    paths: [
      ".codex/config.toml",
      ".codex/AGENTS.md",
      ".codex/skills",
      ".agents/AGENTS.md",
      ".agents/skills",
    ],
  },
  { group: "t3", paths: [".t3/userdata/settings.json", ".t3/userdata/keybindings.json"] },
] as const;

/** `sha256:<hex>` for a file, `symlink:<target>` for a link, `absent` for a missing target. */
export type BaselineEntry = string;

export interface Baseline {
  takenAt: string;
  entries: Record<string, BaselineEntry>;
}

export interface Drift {
  path: string;
  before: BaselineEntry;
  after: BaselineEntry;
}

const ABSENT = "absent";

export function takeBaseline(home: string): Baseline {
  const entries: Record<string, BaselineEntry> = {};
  for (const target of BASELINE_TARGETS) {
    for (const path of target.paths) {
      record(home, path, entries, true);
    }
  }
  return { takenAt: new Date().toISOString(), entries };
}

function record(
  home: string,
  path: string,
  entries: Record<string, BaselineEntry>,
  isTarget: boolean,
): void {
  let stats;
  try {
    stats = lstatSync(join(home, path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (isTarget) entries[path] = ABSENT;
    return;
  }
  if (stats.isSymbolicLink()) {
    entries[path] = `symlink:${readlinkSync(join(home, path))}`;
  } else if (stats.isDirectory()) {
    for (const name of readdirSync(join(home, path)).sort()) {
      record(home, `${path}/${name}`, entries, false);
    }
  } else if (stats.isFile()) {
    entries[path] = `sha256:${createHash("sha256")
      .update(readFileSync(join(home, path)))
      .digest("hex")}`;
  }
}

/** Entries that differ between two baselines, sorted by path. A missing entry counts as absent. */
export function diffBaselines(before: Baseline, after: Baseline): Drift[] {
  const paths = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  const drift: Drift[] = [];
  for (const path of [...paths].sort()) {
    const was = before.entries[path] ?? ABSENT;
    const now = after.entries[path] ?? ABSENT;
    if (was !== now) drift.push({ path, before: was, after: now });
  }
  return drift;
}
