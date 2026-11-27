import type { Database } from "better-sqlite3";
import { diffValues, getAt, overlaps, setAt, type Change } from "./diff.js";
import {
  ConfigValidationError,
  emptyConfig,
  normalizeConfig,
  validateConfig,
  type FactoryConfig,
} from "./document.js";
import { isDeepStrictEqual } from "node:util";

export type VersionState = "draft" | "approved" | "deployed" | "rejected" | "superseded";

/** Who files a draft version that waits on Proposals: the improver, or an update's starter skills. */
const PROPOSERS: readonly string[] = ["improver", "hephaestus"];

/** Whether a version is a proposal, which the Proposals page lists. */
export function isProposal(version: { author: string }): boolean {
  return PROPOSERS.includes(version.author);
}

/** The longest title a version may have, so a list of versions stays one line a row. */
export const MAX_TITLE_LENGTH = 72;

/**
 * A short title from the start of a message, for a version saved without one:
 * its first line, then its first sentence, cut at a word to fit the limit.
 */
export function titleFromMessage(message: string): string {
  const line = message.trim().split("\n")[0]?.trim() ?? "";
  const sentence = /^(.+?[.!?])\s/.exec(`${line} `)?.[1] ?? line;
  const text = sentence.replace(/\.$/, "");
  if (text.length <= MAX_TITLE_LENGTH) return text;
  const room = MAX_TITLE_LENGTH - 3;
  const cut = text.slice(0, room + 1).lastIndexOf(" ");
  return `${text.slice(0, cut > room / 2 ? cut : room).trimEnd()}...`;
}

export interface ConfigVersion {
  id: number;
  parentId: number | null;
  state: VersionState;
  author: string;
  /** A short name for the change. A version saved without one has one made from its message. */
  title: string;
  /** What the change does and why. */
  message: string;
  createdAt: string;
  document: FactoryConfig;
}

interface Row {
  id: number;
  parent_id: number | null;
  state: VersionState;
  author: string;
  title: string;
  message: string;
  created_at: string;
  document: string;
}

export interface NewVersion {
  document: FactoryConfig;
  author: string;
  /** A short name for the change, at most {@link MAX_TITLE_LENGTH} characters. Made from the message when absent. */
  title?: string;
  message: string;
  /** The version this one was built from. Required once any version exists. */
  parentId?: number;
}

export interface RevertResult {
  version: ConfigVersion;
  /** Changes the reverted version made that a later version changed again; these are left as they are. */
  conflicts: Change[];
}

/** A revert whose draft would be the current version again, so there is nothing to save. */
export class NothingToRevertError extends Error {
  constructor(id: number) {
    super(
      `Reverting version ${String(id)} would change nothing: the current config already has none of its changes, or a later version changed them again.`,
    );
  }
}

export class VersionNotFoundError extends Error {
  constructor(id: number) {
    super(`Config version ${String(id)} does not exist.`);
  }
}

function toVersion(row: Row): ConfigVersion {
  return {
    id: row.id,
    parentId: row.parent_id,
    state: row.state,
    author: row.author,
    title: row.title === "" ? titleFromMessage(row.message) : row.title,
    message: row.message,
    createdAt: row.created_at,
    // A setting added since the version was saved reads as its default.
    document: normalizeConfig(JSON.parse(row.document)) as FactoryConfig,
  };
}

/** Numbered snapshots of the whole factory config, kept in Hephaestus's state database. */
export class ConfigStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  createVersion({ document, author, title = "", message, parentId }: NewVersion): ConfigVersion {
    const name = title.trim();
    if (name.length > MAX_TITLE_LENGTH) {
      throw new Error(
        `A title is at most ${String(MAX_TITLE_LENGTH)} characters; this one has ${String(name.length)}. Put the detail in the message.`,
      );
    }
    const normalized = validateConfig(normalizeConfig(document));
    // One write transaction, so two writers cannot both create a first version.
    const insert = this.db.transaction(() => {
      if (parentId === undefined) {
        if (this.count() > 0) throw new Error("A new version needs the parent it was built from.");
      } else {
        this.get(parentId);
      }
      return this.db
        .prepare(
          `INSERT INTO config_versions (parent_id, state, author, title, message, created_at, document)
           VALUES (?, 'draft', ?, ?, ?, ?, ?)`,
        )
        .run(
          parentId ?? null,
          author,
          name,
          message,
          this.now().toISOString(),
          JSON.stringify(normalized),
        );
    });
    const result = insert.immediate();
    return this.get(Number(result.lastInsertRowid));
  }

  get(id: number): ConfigVersion {
    const row = this.db.prepare("SELECT * FROM config_versions WHERE id = ?").get(id) as
      Row | undefined;
    if (row === undefined) throw new VersionNotFoundError(id);
    return toVersion(row);
  }

  /** All versions, newest first. */
  list(): ConfigVersion[] {
    return (this.db.prepare("SELECT * FROM config_versions ORDER BY id DESC").all() as Row[]).map(
      toVersion,
    );
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM config_versions").get() as { n: number }).n;
  }

  /**
   * The version new edits build on: the deployed version, else the newest
   * approved one, else the newest version that was not rejected.
   */
  current(): ConfigVersion | undefined {
    const row = (this.db.prepare("SELECT * FROM config_versions WHERE state = 'deployed'").get() ??
      this.db
        .prepare("SELECT * FROM config_versions WHERE state = 'approved' ORDER BY id DESC LIMIT 1")
        .get() ??
      this.db
        .prepare("SELECT * FROM config_versions WHERE state != 'rejected' ORDER BY id DESC LIMIT 1")
        .get()) as Row | undefined;
    return row === undefined ? undefined : toVersion(row);
  }

  /** What this version changed relative to its parent, or to an empty config for the first version. */
  diff(id: number): Change[] {
    const version = this.get(id);
    const parent = version.parentId === null ? emptyConfig() : this.get(version.parentId).document;
    return diffValues(parent, version.document);
  }

  /**
   * Whether `document` holds what version `id` holds once both are normalized,
   * so key order, spacing, and defaults spelled out do not count as a change.
   */
  isSameAs(id: number, document: unknown): boolean {
    const normalized = normalizeConfig(structuredClone(document));
    return diffValues(this.get(id).document, normalized).length === 0;
  }

  approve(id: number): void {
    this.transition(id, "draft", "approved");
  }

  reject(id: number): void {
    this.transition(id, "draft", "rejected");
  }

  /** Throws unless the version is approved and built from the deployed version. */
  assertDeployable(id: number): void {
    this.assertState(id, "approved");
    const deployed = this.db
      .prepare("SELECT id FROM config_versions WHERE state = 'deployed'")
      .get() as { id: number } | undefined;
    const { parentId } = this.get(id);
    if (deployed !== undefined && parentId !== deployed.id) {
      throw new Error(
        `Version ${String(id)} was built from version ${String(parentId)}, but version ${String(deployed.id)} is deployed. Build it again from version ${String(deployed.id)}.`,
      );
    }
  }

  /**
   * Marks an approved version as deployed and the previously deployed one as
   * superseded. The version must be built from the deployed version, so
   * deploying it cannot silently drop changes made in between.
   */
  markDeployed(id: number): void {
    this.db.transaction(() => {
      this.assertDeployable(id);
      this.db
        .prepare("UPDATE config_versions SET state = 'superseded' WHERE state = 'deployed'")
        .run();
      this.db.prepare("UPDATE config_versions SET state = 'deployed' WHERE id = ?").run(id);
    })();
  }

  /**
   * Builds a draft on the current version that undoes what `id` changed. A
   * change is left as it is, and reported as a conflict, when a later version
   * changed the same path, when the value has changed since, or when undoing it
   * alone would make the config invalid.
   */
  revert(id: number, author: string): RevertResult {
    const { base, document, conflicts } = this.planRevert(id);
    if (this.isSameAs(base.id, document)) throw new NothingToRevertError(id);
    const version = this.createVersion({
      document,
      author,
      message: `Revert version ${String(id)}`,
      parentId: base.id,
    });
    return { version, conflicts };
  }

  /** Whether reverting `id` now would build a draft that differs from the current version. */
  canRevert(id: number): boolean {
    const { base, document } = this.planRevert(id);
    return !this.isSameAs(base.id, document);
  }

  /** What {@link revert} would build, without saving it. */
  private planRevert(id: number): {
    base: ConfigVersion;
    document: FactoryConfig;
    conflicts: Change[];
  } {
    const target = this.get(id);
    if (target.state !== "deployed" && target.state !== "superseded") {
      throw new Error(
        `Only a version that was deployed can be reverted; ${String(id)} is ${target.state}.`,
      );
    }
    if (target.parentId === null) {
      throw new Error("The first version has nothing before it to revert to.");
    }
    const base = this.current();
    if (base === undefined) throw new VersionNotFoundError(id);
    const later = this.laterChanges(base, id);
    let document = structuredClone(base.document) as unknown as Record<string, unknown>;
    const conflicts: Change[] = [];
    let pending: Change[] = [];
    for (const change of this.diff(id)) {
      const touchedLater = later.some((path) => overlaps(path, change.path));
      if (touchedLater || !isDeepStrictEqual(getAt(document, change.path), change.after)) {
        conflicts.push(change);
      } else {
        pending.push(change);
      }
    }
    // Undo everything at once when that is valid. Otherwise apply changes one
    // at a time, retrying the rest after each success, so a change that depends
    // on another (a role using a restored skill) lands once its dependency has.
    const undoAll = applyChanges(document, pending);
    if (isValidConfig(undoAll)) {
      document = undoAll;
      pending = [];
    }
    for (let progress = true; progress && pending.length > 0;) {
      progress = false;
      for (const change of [...pending]) {
        const attempt = applyChanges(document, [change]);
        if (!isValidConfig(attempt)) continue;
        document = attempt;
        pending = pending.filter((other) => other !== change);
        progress = true;
      }
    }
    conflicts.push(...pending);
    return { base, document: document as unknown as FactoryConfig, conflicts };
  }

  /** Paths changed by the versions from `base` back to, but not including, version `id`. */
  private laterChanges(base: ConfigVersion, id: number): string[][] {
    const paths: string[][] = [];
    let version: ConfigVersion | undefined = base;
    while (version !== undefined && version.id !== id) {
      paths.push(...this.diff(version.id).map((change) => change.path));
      version = version.parentId === null ? undefined : this.get(version.parentId);
    }
    return paths;
  }

  /** Every version as stored, oldest first, for backups. */
  exportVersions(): ConfigVersion[] {
    return this.list().reverse();
  }

  /** Loads versions from a backup into an empty store, keeping their ids and states. */
  importVersions(versions: ConfigVersion[]): void {
    if (this.count() > 0) throw new Error("Restore needs an empty config store.");
    const insert = this.db.prepare(
      `INSERT INTO config_versions (id, parent_id, state, author, message, created_at, document)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const version of versions) {
        // A backup from before a setting existed restores with that setting's default.
        const document = validateConfig(normalizeConfig(structuredClone(version.document)));
        insert.run(
          version.id,
          version.parentId,
          version.state,
          version.author,
          version.message,
          version.createdAt,
          JSON.stringify(document),
        );
      }
    })();
  }

  private assertState(id: number, expected: VersionState): void {
    const { state } = this.get(id);
    if (state !== expected) {
      throw new Error(
        `Version ${String(id)} is ${state}; this needs a version that is ${expected}.`,
      );
    }
  }

  private transition(id: number, from: VersionState, to: VersionState): void {
    this.db.transaction(() => {
      this.assertState(id, from);
      this.db.prepare("UPDATE config_versions SET state = ? WHERE id = ?").run(to, id);
    })();
  }
}

/** A copy of `document` with each change undone. */
function applyChanges(
  document: Record<string, unknown>,
  changes: Change[],
): Record<string, unknown> {
  const copy = structuredClone(document);
  for (const change of changes) setAt(copy, change.path, change.before);
  return copy;
}

function isValidConfig(document: unknown): boolean {
  try {
    validateConfig(document);
    return true;
  } catch (error) {
    if (error instanceof ConfigValidationError) return false;
    throw error;
  }
}
