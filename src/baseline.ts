import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/** Files and folders inside a Hermes profile that the owner writes. */
const HERMES_PROFILE_PATHS = ["config.yaml", ".env", "SOUL.md", "skills", "hooks"];

/**
 * Owner-authored config that Hephaestus must leave unchanged, as paths relative
 * to the home directory. Credentials and runtime state are left out because
 * they change during normal use, and so is `~/.claude.json`, which Claude Code
 * rewrites on every session. Named Hermes profiles under `.hermes/profiles/`
 * are added when the baseline is taken.
 */
export const BASELINE_TARGETS = [
  { group: "hermes", paths: HERMES_PROFILE_PATHS.map((path) => `.hermes/${path}`) },
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

/**
 * `sha256:<hex>` for a file, `symlink:<target>` for a link (followed by
 * ` sha256:<hex>` when it points at a file), and `absent` for a missing target.
 * The files inside a linked directory are recorded under the link's path.
 */
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
  const visited = new Set<string>();
  for (const path of targetPaths(home)) {
    record(home, path, entries, visited, true);
  }
  return { takenAt: new Date().toISOString(), entries };
}

function targetPaths(home: string): string[] {
  const paths: string[] = BASELINE_TARGETS.flatMap((target) => [...target.paths]);
  for (const profile of listDirectory(join(home, ".hermes", "profiles"))) {
    paths.push(...HERMES_PROFILE_PATHS.map((path) => `.hermes/profiles/${profile}/${path}`));
  }
  return paths;
}

function listDirectory(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function record(
  home: string,
  path: string,
  entries: Record<string, BaselineEntry>,
  visited: Set<string>,
  isTarget: boolean,
): void {
  const absolute = join(home, path);
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch (error) {
    if (!isMissing(error)) throw error;
    if (isTarget) entries[path] = ABSENT;
    return;
  }

  if (stats.isSymbolicLink()) {
    const link = `symlink:${readlinkSync(absolute)}`;
    let target;
    try {
      target = statSync(absolute);
    } catch (error) {
      if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
      entries[path] = link;
      return;
    }
    if (target.isFile()) {
      entries[path] = `${link} ${hashFile(absolute)}`;
    } else {
      entries[path] = link;
      if (target.isDirectory()) recordDirectory(home, path, entries, visited);
    }
  } else if (stats.isDirectory()) {
    recordDirectory(home, path, entries, visited);
  } else if (stats.isFile()) {
    entries[path] = hashFile(absolute);
  }
}

function recordDirectory(
  home: string,
  path: string,
  entries: Record<string, BaselineEntry>,
  visited: Set<string>,
): void {
  const real = realpathSync(join(home, path));
  if (visited.has(real)) return;
  visited.add(real);
  for (const name of listDirectory(join(home, path))) {
    record(home, `${path}/${name}`, entries, visited, false);
  }
}

function hashFile(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
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

/** Parses a saved baseline, or returns undefined when it is missing or malformed. */
export function readBaseline(path: string): Baseline | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      takenAt?: unknown;
      entries?: unknown;
    };
    if (typeof parsed.entries !== "object" || parsed.entries === null) return undefined;
    const entries = parsed.entries as Record<string, BaselineEntry>;
    return { takenAt: String(parsed.takenAt), entries };
  } catch {
    return undefined;
  }
}
