import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/** Where each tool keeps the owner's config. Install records these, and uninstall reuses them. */
export interface ConfigRoots {
  hermes: string;
  claude: string;
  codex: string;
  agents: string;
  t3: string;
}

/** Resolves config roots the way each tool does: its environment variable, else its default folder. */
export function resolveRoots(env: NodeJS.ProcessEnv, home: string): ConfigRoots {
  const root = (variable: string | undefined, fallback: string): string =>
    variable !== undefined && isAbsolute(variable) ? variable : join(home, fallback);
  return {
    hermes: root(env.HERMES_HOME, ".hermes"),
    claude: root(env.CLAUDE_CONFIG_DIR, ".claude"),
    codex: root(env.CODEX_HOME, ".codex"),
    agents: join(home, ".agents"),
    t3: root(env.T3CODE_HOME, ".t3"),
  };
}

/** Files and folders inside a Hermes profile that the owner writes. */
const HERMES_PROFILE_PATHS = ["config.yaml", ".env", "SOUL.md", "skills", "hooks"];

/**
 * Usage counts, curator state and backups, and locks that Hermes rewrites in a
 * skills folder whenever it uses or curates a skill, so they would show as
 * drift on every run. They are skipped directly under any covered folder named
 * `skills`, so a Claude or Codex skills folder linked to the Hermes one
 * compares cleanly too.
 */
const HERMES_SKILL_BOOKKEEPING = new Set([
  ".usage.json",
  ".usage.json.lock",
  ".curator_state",
  ".curator_ledger.jsonl",
  ".curator_backups",
  ".locks",
]);

/** Whether a baseline key is Hermes skill bookkeeping, or a file inside it. */
function isHermesSkillBookkeeping(path: string): boolean {
  const parts = path.split("/");
  return parts.some(
    (part, index) =>
      index > 0 && parts[index - 1] === "skills" && HERMES_SKILL_BOOKKEEPING.has(part),
  );
}

/**
 * Owner-authored config that Hephaestus must leave unchanged, relative to each
 * tool's config root. Credentials and runtime state are left out because they
 * change during normal use, and so is `~/.claude.json`, which Claude Code
 * rewrites on every session. Named Hermes profiles under `profiles/` are added
 * when the baseline is taken.
 */
export const BASELINE_TARGETS = [
  { group: "hermes", root: "hermes", paths: HERMES_PROFILE_PATHS },
  {
    group: "claude",
    root: "claude",
    paths: ["CLAUDE.md", "settings.json", "settings.local.json", "skills", "agents", "commands"],
  },
  {
    group: "codex",
    root: "codex",
    paths: ["config.toml", "AGENTS.md", "AGENTS.override.md", "rules", "skills"],
  },
  { group: "codex", root: "agents", paths: ["AGENTS.md", "skills"] },
  { group: "t3", root: "t3", paths: ["userdata/settings.json", "userdata/keybindings.json"] },
] as const satisfies readonly {
  group: string;
  root: keyof ConfigRoots;
  paths: readonly string[];
}[];

/**
 * `sha256:<hex>` for a file, `symlink:<target>` for a link (followed by
 * ` sha256:<hex>` when it points at a file), `unreadable:<code>` for a file
 * that cannot be read, and `absent` for a missing target.
 * The files inside a linked directory are recorded under the link's path.
 */
export type BaselineEntry = string;

export interface Baseline {
  takenAt: string;
  roots: ConfigRoots;
  /** Keyed by path relative to the home directory, or absolute for paths outside it. */
  entries: Record<string, BaselineEntry>;
}

export interface Drift {
  path: string;
  before: BaselineEntry;
  after: BaselineEntry;
}

const ABSENT = "absent";

export function takeBaseline(home: string, roots: ConfigRoots = resolveRoots({}, home)): Baseline {
  const entries: Record<string, BaselineEntry> = {};
  for (const path of targetPaths(roots)) {
    record(home, path, entries, new Set(), true);
  }
  return { takenAt: new Date().toISOString(), roots, entries };
}

function targetPaths(roots: ConfigRoots): string[] {
  const paths: string[] = BASELINE_TARGETS.flatMap((target) =>
    target.paths.map((path) => join(roots[target.root], path)),
  );
  for (const profile of listDirectory(join(roots.hermes, "profiles"))) {
    paths.push(
      ...HERMES_PROFILE_PATHS.map((path) => join(roots.hermes, "profiles", profile, path)),
    );
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

function key(home: string, absolute: string): string {
  const path = relative(home, absolute);
  return path.startsWith("..") || isAbsolute(path) ? absolute : path;
}

/**
 * Records one path. `ancestors` holds the real paths of the directories above
 * it on this branch, so a link back up the tree stops while two links to the
 * same folder from different places are both recorded.
 */
function record(
  home: string,
  absolute: string,
  entries: Record<string, BaselineEntry>,
  ancestors: Set<string>,
  isTarget: boolean,
): void {
  const name = key(home, absolute);
  if (isHermesSkillBookkeeping(name)) return;
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch (error) {
    if (!isMissing(error)) throw error;
    if (isTarget) entries[name] = ABSENT;
    return;
  }

  if (stats.isSymbolicLink()) {
    const link = `symlink:${readlinkSync(absolute)}`;
    let target;
    try {
      target = statSync(absolute);
    } catch (error) {
      if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
      entries[name] = link;
      return;
    }
    if (target.isFile()) {
      entries[name] = `${link} ${hashFile(absolute)}`;
    } else {
      entries[name] = link;
      if (target.isDirectory()) recordDirectory(home, absolute, entries, ancestors);
    }
  } else if (stats.isDirectory()) {
    recordDirectory(home, absolute, entries, ancestors);
  } else if (stats.isFile()) {
    entries[name] = hashFile(absolute);
  }
}

function recordDirectory(
  home: string,
  absolute: string,
  entries: Record<string, BaselineEntry>,
  ancestors: Set<string>,
): void {
  const real = realpathSync(absolute);
  if (ancestors.has(real)) return;
  const below = new Set(ancestors).add(real);
  let children: string[];
  try {
    children = listDirectory(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw error;
    entries[key(home, absolute)] = `unreadable:${code}`;
    return;
  }
  for (const child of children) {
    record(home, join(absolute, child), entries, below, false);
  }
}

/** A file's hash, or `unreadable:<code>` when it exists but cannot be read. */
function hashFile(path: string): string {
  try {
    return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return `unreadable:${code}`;
    throw error;
  }
}

/**
 * Entries that differ between two baselines, sorted by path. A missing entry
 * counts as absent. Hermes skill bookkeeping is skipped, so a baseline taken
 * before it was left out compares cleanly.
 */
export function diffBaselines(before: Baseline, after: Baseline): Drift[] {
  const paths = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  const drift: Drift[] = [];
  for (const path of [...paths].sort()) {
    if (isHermesSkillBookkeeping(path)) continue;
    const was = before.entries[path] ?? ABSENT;
    const now = after.entries[path] ?? ABSENT;
    if (was !== now) drift.push({ path, before: was, after: now });
  }
  return drift;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses a saved baseline, or returns undefined when it is missing or malformed. */
export function readBaseline(path: string): Baseline | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.takenAt !== "string") return undefined;
  const { roots, entries } = parsed;
  if (!isRecord(roots) || !isRecord(entries)) return undefined;
  const rootNames: (keyof ConfigRoots)[] = ["hermes", "claude", "codex", "agents", "t3"];
  if (!rootNames.every((name) => typeof roots[name] === "string" && isAbsolute(roots[name]))) {
    return undefined;
  }
  if (!Object.values(entries).every((entry) => typeof entry === "string")) return undefined;
  return parsed as unknown as Baseline;
}
