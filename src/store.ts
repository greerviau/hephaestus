import BetterSqlite3, { type Database } from "better-sqlite3";
import { renamePlannerInStore } from "./legacy-planner.js";

/**
 * Rewrites the word "card" to "task" in text an earlier build stored, with the casing kept: the
 * whole word and its plural, and the JSON keys an MCP call recorded. Words that only contain
 * "card", such as "discard", and hyphenated names such as a branch, stay.
 */
export function renameCardWords(text: string | null): string | null {
  if (text === null) return null;
  return text
    .replace(
      /(?<![\w-])(Cards?|cards?)(?![\w-])/g,
      (word) => `${word.startsWith("C") ? "T" : "t"}${word.slice(1).replace("ard", "ask")}`,
    )
    .replace(/"card_id"/g, '"task_id"')
    .replace(/"cards_by_stage"/g, '"tasks_by_stage"')
    .replace(/"hermes_card_id"/g, '"hermes_task_id"');
}

type Migration = string | ((db: Database) => void);

const MIGRATIONS: Migration[] = [
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
  // A card whose thread stopped on a provider's usage limit waits for it to reset.
  `ALTER TABLE cards ADD COLUMN limit_until TEXT;
   ALTER TABLE cards ADD COLUMN limit_run TEXT;`,
  // Changes to the factory's own skills, instructions, and settings agreed in a chat.
  `CREATE TABLE chat_changes (
     id INTEGER PRIMARY KEY,
     target TEXT NOT NULL,
     summary TEXT NOT NULL,
     conversation TEXT NOT NULL,
     state TEXT NOT NULL,
     before_text TEXT,
     after_text TEXT NOT NULL,
     proposed_at TEXT NOT NULL,
     approval TEXT,
     applied_at TEXT,
     version_id INTEGER,
     error TEXT,
     revert_conversation TEXT,
     revert_request TEXT,
     reverted_at TEXT,
     revert_version_id INTEGER
   );`,
  // What the upload of each file attached to a factory-filed issue returned, for the engineer's instructions.
  `CREATE TABLE issue_attachments (
     repo TEXT NOT NULL COLLATE NOCASE,
     number INTEGER NOT NULL,
     path TEXT NOT NULL,
     name TEXT NOT NULL,
     commit_sha TEXT NOT NULL,
     sha256 TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     PRIMARY KEY (repo, number, path)
   );`,
  // What T3 reported a thread used. NULL means T3 did not report it, which is not zero.
  `ALTER TABLE factory_threads ADD COLUMN input_tokens INTEGER;
   ALTER TABLE factory_threads ADD COLUMN output_tokens INTEGER;
   ALTER TABLE factory_threads ADD COLUMN cost_usd REAL;`,
  // The run that wrote each item, so a thread's result is read from its latest run alone.
  `ALTER TABLE thread_items ADD COLUMN run_id TEXT;`,
  // The run T3 last reported for each factory thread, so a run that wrote no item is still told apart.
  `ALTER TABLE factory_threads ADD COLUMN latest_run_id TEXT;`,
  // "Card" became "Task" everywhere. The rows stay; names change, and so do the words in stored text.
  (db) => {
    db.exec(`ALTER TABLE cards RENAME TO tasks;
      ALTER TABLE card_events RENAME TO task_events;
      ALTER TABLE tasks RENAME COLUMN hermes_card_id TO hermes_task_id;
      ALTER TABLE task_events RENAME COLUMN card_id TO task_id;
      ALTER TABLE review_results RENAME COLUMN card_id TO task_id;
      ALTER TABLE factory_threads RENAME COLUMN card_id TO task_id;
      ALTER TABLE factory_launches RENAME COLUMN card_id TO task_id;
      ALTER TABLE issues RENAME COLUMN card_id TO task_id;
      ALTER TABLE merges RENAME COLUMN card_id TO task_id;
      ALTER TABLE notifications RENAME COLUMN card_id TO task_id;
      DROP INDEX card_events_by_card;
      CREATE INDEX task_events_by_task ON task_events (task_id, id);
      UPDATE mcp_calls SET tool = 'list_tasks' WHERE tool = 'list_cards';`);
    for (const [table, key, columns] of [
      ["mcp_calls", "id", ["arguments", "result"]],
      ["notifications", "id", ["text"]],
      ["task_events", "id", ["detail"]],
      ["factory_threads", "rowid", ["title"]],
      ["factory_launches", "rowid", ["title"]],
      ["tasks", "id", ["title", "reason", "pending_message"]],
    ] as const) {
      const update = db.prepare(
        `UPDATE ${table} SET ${columns.map((column) => `${column} = @${column}`).join(", ")} WHERE ${key} = @key`,
      );
      const rows = db
        .prepare(`SELECT ${key} AS key, ${columns.join(", ")} FROM ${table}`)
        .all() as ({ key: number } & Record<string, string | null>)[];
      for (const row of rows) {
        const next = Object.fromEntries(
          columns.map((column) => [column, renameCardWords(row[column] ?? null)]),
        );
        if (columns.some((column) => next[column] !== row[column])) {
          update.run({ ...next, key: row.key });
        }
      }
    }
  },
  // When a task's start was first asked for while its worker had no free task slot, for its place in the queue.
  // A start asked for while paused, before queues existed, keeps its place from when it was asked.
  `ALTER TABLE tasks ADD COLUMN queued_at TEXT;
   UPDATE tasks SET queued_at = updated_at WHERE stage = 'Admitted' AND brief IS NOT NULL;`,
  // "Planner" became "Communicator". The files move when the factory Hermes root is next synced.
  renamePlannerInStore,
  // The lead's queue of work waiting to start, in the lead's order, and its deferrals. A task
  // whose start was asked for before the queue existed waited as Admitted with a brief, or in
  // Implementing with no thread; both move to the queue, oldest request first. A task with a
  // pending or answered launch keeps its stage, since T3 may have its thread, and a task whose
  // launch was refused keeps its worker. Their board tasks are parked on the next pass.
  `ALTER TABLE tasks ADD COLUMN queue_order INTEGER;
   ALTER TABLE tasks ADD COLUMN defer_reason TEXT;
   ALTER TABLE tasks ADD COLUMN defer_after INTEGER;
   ALTER TABLE tasks ADD COLUMN defer_mark INTEGER;
   ALTER TABLE tasks ADD COLUMN triage_since TEXT;
   ALTER TABLE tasks ADD COLUMN triage_alerted INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE tasks ADD COLUMN park_pending INTEGER NOT NULL DEFAULT 0;
   CREATE TEMP TABLE queued_on_upgrade AS
     SELECT id, ROW_NUMBER() OVER (ORDER BY COALESCE(queued_at, updated_at), id) AS place
     FROM tasks
     WHERE ((stage = 'Implementing' AND implement_thread IS NULL AND started_at IS NULL)
            OR (stage = 'Admitted' AND brief IS NOT NULL))
       AND NOT EXISTS (SELECT 1 FROM factory_launches l
                       WHERE l.task_id = CAST(tasks.id AS TEXT) AND l.status IN ('pending', 'launched'));
   UPDATE tasks SET stage = 'Queued', waiting = NULL, version = version + 1, park_pending = 1,
     queue_order = (SELECT place FROM queued_on_upgrade q WHERE q.id = tasks.id),
     worker_env = CASE WHEN EXISTS (SELECT 1 FROM factory_launches l
                                    WHERE l.task_id = CAST(tasks.id AS TEXT))
                  THEN worker_env ELSE NULL END
   WHERE id IN (SELECT id FROM queued_on_upgrade);
   INSERT INTO task_events (task_id, at, kind, detail)
     SELECT id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'stage:Queued',
            'moved to the queue: it had not started a thread'
     FROM queued_on_upgrade;
   DROP TABLE queued_on_upgrade;
   ALTER TABLE tasks DROP COLUMN queued_at;`,
  // A version's short title, apart from the message that describes it. A version saved before
  // keeps an empty title, and reads with one made from its message.
  `ALTER TABLE config_versions ADD COLUMN title TEXT NOT NULL DEFAULT '';`,
];

/** Opens Hephaestus's SQLite state database and applies any pending migrations. */
export function openStore(path: string): Database {
  const db = new BetterSqlite3(path);
  db.pragma("journal_mode = WAL");
  const applied = db.pragma("user_version", { simple: true }) as number;
  for (const [index, sql] of MIGRATIONS.entries()) {
    if (index < applied) continue;
    db.transaction(() => {
      if (typeof sql === "string") db.exec(sql);
      else sql(db);
      db.pragma(`user_version = ${String(index + 1)}`);
    })();
  }
  return db;
}
