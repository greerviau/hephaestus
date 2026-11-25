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
  `CREATE TABLE factory_threads (
     environment_id TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     title TEXT NOT NULL,
     provider_instance_id TEXT NOT NULL,
     model TEXT NOT NULL,
     config_version INTEGER NOT NULL,
     card_id TEXT,
     status TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (environment_id, thread_id)
   );
   CREATE TABLE thread_items (
     environment_id TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     item_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     type TEXT NOT NULL,
     status TEXT NOT NULL,
     text TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (environment_id, thread_id, item_id),
     FOREIGN KEY (environment_id, thread_id) REFERENCES factory_threads (environment_id, thread_id)
   );`,
  `CREATE TABLE factory_launches (
     client_request_id TEXT PRIMARY KEY,
     environment_id TEXT NOT NULL,
     title TEXT NOT NULL,
     provider_instance_id TEXT NOT NULL,
     model TEXT NOT NULL,
     config_version INTEGER NOT NULL,
     card_id TEXT,
     status TEXT NOT NULL CHECK (status IN ('pending', 'launched', 'failed')),
     thread_id TEXT,
     error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  `CREATE TABLE hermes_cron_jobs (
     role TEXT NOT NULL,
     name TEXT NOT NULL,
     job_id TEXT NOT NULL,
     PRIMARY KEY (role, name)
   );
   CREATE TABLE hermes_skills (
     role TEXT NOT NULL,
     name TEXT NOT NULL,
     PRIMARY KEY (role, name)
   );`,
  `ALTER TABLE factory_threads ADD COLUMN kind TEXT NOT NULL DEFAULT 'factory';
   ALTER TABLE factory_launches ADD COLUMN kind TEXT NOT NULL DEFAULT 'factory';
   CREATE TABLE workers (
     environment_id TEXT PRIMARY KEY,
     label TEXT NOT NULL,
     enabled INTEGER NOT NULL,
     home TEXT,
     deployed_version INTEGER,
     deployed_sha TEXT,
     instance_problem TEXT,
     checked_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE worker_tasks (
     id INTEGER PRIMARY KEY,
     environment_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN
       ('deploy', 'claude-sign-in', 'codex-sign-in', 'test-claude', 'test-codex', 'cleanup')),
     client_request_id TEXT NOT NULL UNIQUE,
     message TEXT NOT NULL DEFAULT '',
     thread_id TEXT,
     version INTEGER,
     sha TEXT,
     status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
     detail TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX worker_tasks_by_worker ON worker_tasks (environment_id, kind, id);`,
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
