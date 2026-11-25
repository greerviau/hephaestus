import type { Database } from "better-sqlite3";
import { diffValues, getAt, setAt, type Change } from "./diff.js";
import { emptyConfig, validateConfig, type FactoryConfig } from "./document.js";
import { isDeepStrictEqual } from "node:util";

export type VersionState = "draft" | "approved" | "deployed" | "rejected" | "superseded";

export interface ConfigVersion {
  id: number;
  parentId: number | null;
  state: VersionState;
  author: string;
  message: string;
  createdAt: string;
  document: FactoryConfig;
}

interface Row {
  id: number;
  parent_id: number | null;
  state: VersionState;
  author: string;
  message: string;
  created_at: string;
  document: string;
}

export interface NewVersion {
  document: FactoryConfig;
  author: string;
  message: string;
  /** The version this one was built from. Required once any version exists. */
  parentId?: number;
}

export interface RevertResult {
  version: ConfigVersion;
  /** Changes the reverted version made that a later version changed again; these are left as they are. */
  conflicts: Change[];
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
    message: row.message,
    createdAt: row.created_at,
    document: JSON.parse(row.document) as FactoryConfig,
  };
}

/** Numbered snapshots of the whole factory config, kept in Hephaestus's state database. */
export class ConfigStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  createVersion({ document, author, message, parentId }: NewVersion): ConfigVersion {
    validateConfig(document);
    if (parentId === undefined) {
      if (this.count() > 0) throw new Error("A new version needs the parent it was built from.");
    } else {
      this.get(parentId);
    }
    const result = this.db
      .prepare(
        `INSERT INTO config_versions (parent_id, state, author, message, created_at, document)
         VALUES (?, 'draft', ?, ?, ?, ?)`,
      )
      .run(parentId ?? null, author, message, this.now().toISOString(), JSON.stringify(document));
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

  /** The deployed version, or the newest version when none is deployed yet. */
  current(): ConfigVersion | undefined {
    const row = (this.db.prepare("SELECT * FROM config_versions WHERE state = 'deployed'").get() ??
      this.db.prepare("SELECT * FROM config_versions ORDER BY id DESC LIMIT 1").get()) as
      Row | undefined;
    return row === undefined ? undefined : toVersion(row);
  }

  /** What this version changed relative to its parent, or to an empty config for the first version. */
  diff(id: number): Change[] {
    const version = this.get(id);
    const parent = version.parentId === null ? emptyConfig() : this.get(version.parentId).document;
    return diffValues(parent, version.document);
  }

  approve(id: number): void {
    this.transition(id, "draft", "approved");
  }

  reject(id: number): void {
    this.transition(id, "draft", "rejected");
  }

  /** Marks an approved version as deployed and the previously deployed one as superseded. */
  markDeployed(id: number): void {
    this.db.transaction(() => {
      this.assertState(id, "approved");
      this.db
        .prepare("UPDATE config_versions SET state = 'superseded' WHERE state = 'deployed'")
        .run();
      this.db.prepare("UPDATE config_versions SET state = 'deployed' WHERE id = ?").run(id);
    })();
  }

  /**
   * Builds a draft on the current version that undoes what `id` changed. A path
   * that a later version changed again keeps its later value and is reported.
   */
  revert(id: number, author: string): RevertResult {
    const target = this.get(id);
    if (target.state !== "deployed" && target.state !== "superseded") {
      throw new Error(
        `Only a version that was deployed can be reverted; ${String(id)} is ${target.state}.`,
      );
    }
    const base = this.current();
    if (base === undefined) throw new VersionNotFoundError(id);
    const document = structuredClone(base.document) as unknown as Record<string, unknown>;
    const conflicts: Change[] = [];
    for (const change of this.diff(id)) {
      if (isDeepStrictEqual(getAt(document, change.path), change.after)) {
        setAt(document, change.path, change.before);
      } else {
        conflicts.push(change);
      }
    }
    const version = this.createVersion({
      document: document as unknown as FactoryConfig,
      author,
      message: `Revert version ${String(id)}`,
      parentId: base.id,
    });
    return { version, conflicts };
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
        validateConfig(version.document);
        insert.run(
          version.id,
          version.parentId,
          version.state,
          version.author,
          version.message,
          version.createdAt,
          JSON.stringify(version.document),
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
