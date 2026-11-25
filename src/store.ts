import BetterSqlite3, { type Database } from "better-sqlite3";

const MIGRATIONS = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );`,
  `CREATE TABLE config_versions (
     id INTEGER PRIMARY KEY,
     parent_id INTEGER REFERENCES config_versions (id),
     state TEXT NOT NULL CHECK (state IN ('draft', 'approved', 'deployed', 'rejected', 'superseded')),
     author TEXT NOT NULL,
     message TEXT NOT NULL,
     created_at TEXT NOT NULL,
     document TEXT NOT NULL
   );
   CREATE UNIQUE INDEX one_deployed_version ON config_versions (state) WHERE state = 'deployed';`,
];

/** Opens Hephaestus's SQLite state database and applies any pending migrations. */
export function openStore(path: string): Database {
  const db = new BetterSqlite3(path);
  db.pragma("journal_mode = WAL");
  const applied = db.pragma("user_version", { simple: true }) as number;
  for (const [index, sql] of MIGRATIONS.entries()) {
    if (index < applied) continue;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${String(index + 1)}`);
    })();
  }
  return db;
}
