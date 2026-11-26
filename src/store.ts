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
     created_seq INTEGER NOT NULL DEFAULT 0,
     done_seq INTEGER,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX worker_tasks_by_worker ON worker_tasks (environment_id, kind, id);`,
  `CREATE TABLE issues (
     repo TEXT NOT NULL,
     number INTEGER NOT NULL,
     title TEXT NOT NULL,
     author TEXT NOT NULL,
     provenance TEXT NOT NULL CHECK (provenance IN ('factory', 'external')),
     filed_by TEXT,
     state TEXT NOT NULL CHECK (state IN ('admitted', 'awaiting-owner', 'held-cap', 'rejected')),
     card_id INTEGER,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (repo, number)
   );
   CREATE TABLE cards (
     id INTEGER PRIMARY KEY,
     repo TEXT NOT NULL,
     issue_number INTEGER,
     title TEXT NOT NULL,
     stage TEXT NOT NULL,
     hermes_card_id TEXT,
     brief TEXT,
     worker_env TEXT,
     project_id TEXT,
     base_branch TEXT,
     implementer TEXT,
     implement_thread TEXT,
     review_thread TEXT,
     handled_item TEXT,
     pr_number INTEGER,
     head_sha TEXT,
     rounds INTEGER NOT NULL DEFAULT 0,
     escalated_to TEXT,
     reason TEXT,
     waiting TEXT,
     merge_sha TEXT,
     revert_pr INTEGER,
     owner_approved_sha TEXT,
     pending_message TEXT,
     owner_action TEXT CHECK (owner_action IN ('merge', 'revert-merge')),
     branch TEXT,
     head_at TEXT,
     expected_checks TEXT,
     started_at TEXT,
     foreign_merge INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE card_events (
     id INTEGER PRIMARY KEY,
     card_id INTEGER NOT NULL REFERENCES cards (id),
     at TEXT NOT NULL,
     kind TEXT NOT NULL,
     detail TEXT NOT NULL
   );
   CREATE INDEX card_events_by_card ON card_events (card_id, id);
   CREATE TABLE review_results (
     card_id INTEGER NOT NULL REFERENCES cards (id),
     head_sha TEXT NOT NULL,
     reviewer TEXT NOT NULL,
     author TEXT NOT NULL,
     verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'changes')),
     thread_id TEXT NOT NULL,
     at TEXT NOT NULL
   );
   CREATE TABLE merges (
     repo TEXT NOT NULL,
     pr_number INTEGER NOT NULL,
     merge_sha TEXT NOT NULL,
     card_id INTEGER,
     revert INTEGER NOT NULL DEFAULT 0,
     at TEXT NOT NULL,
     PRIMARY KEY (repo, pr_number)
   );
   CREATE TABLE worker_projects (
     environment_id TEXT NOT NULL,
     repo TEXT NOT NULL,
     project_id TEXT NOT NULL,
     PRIMARY KEY (environment_id, repo)
   );
   CREATE TABLE mcp_calls (
     id INTEGER PRIMARY KEY,
     role TEXT NOT NULL,
     tool TEXT NOT NULL,
     arguments TEXT NOT NULL,
     ok INTEGER NOT NULL,
     result TEXT NOT NULL,
     at TEXT NOT NULL
   );
   CREATE TABLE notifications (
     id INTEGER PRIMARY KEY,
     at TEXT NOT NULL,
     card_id INTEGER,
     text TEXT NOT NULL,
     dismissed INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE version_evidence (
     version_id INTEGER NOT NULL REFERENCES config_versions (id),
     environment_id TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT ''
   );`,
  `ALTER TABLE notifications ADD COLUMN kind TEXT NOT NULL DEFAULT 'info';`,
  `ALTER TABLE merges ADD COLUMN foreign_merge INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE issues ADD COLUMN closed INTEGER NOT NULL DEFAULT 0;`,
  // The backfills are safe to run on a database that already ran an earlier form of them.
  `UPDATE notifications SET kind = 'escalation' WHERE text LIKE 'Card % needs you: %';
   ALTER TABLE issues ADD COLUMN checked_at TEXT;
   ALTER TABLE cards ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE cards ADD COLUMN reverting INTEGER NOT NULL DEFAULT 0;
   UPDATE cards SET reverting = 1
   WHERE stage NOT IN ('Done', 'Abandoned')
   AND (SELECT MAX(id) FROM card_events WHERE card_id = cards.id AND kind = 'stage:Reverting')
     > COALESCE((SELECT MAX(id) FROM card_events WHERE card_id = cards.id AND kind = 'stage:Implementing'), 0);`,
  // Issue reads are ordered by a counter, which a clock change cannot reorder.
  `ALTER TABLE issues DROP COLUMN checked_at;
   ALTER TABLE issues ADD COLUMN read_order INTEGER NOT NULL DEFAULT 0;`,
  // When Hephaestus settled a finished thread in T3, so each is settled once.
  `ALTER TABLE factory_threads ADD COLUMN settled_at TEXT;`,
  // The policy a card last ran under, so a merge in flight can finish if its project is removed.
  `ALTER TABLE cards ADD COLUMN policy TEXT;`,
  // The chat thread each request came from, so its progress is posted there.
  `CREATE TABLE chat_threads (
     repo TEXT NOT NULL COLLATE NOCASE,
     number INTEGER NOT NULL,
     platform TEXT NOT NULL,
     chat TEXT NOT NULL,
     linked_at TEXT NOT NULL,
     PRIMARY KEY (repo, number)
   );`,
  // The newest card event the thread's catch-up covered; 0 until the catch-up is sent.
  `ALTER TABLE chat_threads ADD COLUMN after_event INTEGER NOT NULL DEFAULT 0;`,
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
