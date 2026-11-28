import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { ConfigStore } from "../src/config/store.js";
import { openStore, renameCardWords } from "../src/store.js";

/**
 * Puts a current database back into the shape it had before "card" became "task", so a test can
 * start an upgrade from an installed factory's schema. The old migrations are not kept as code,
 * so this is their last form: the same tables, columns, and index under their old names.
 */
function backToCardSchema(db: Database): void {
  backToBeforeQueue(db);
  // queued_at came after the rename.
  db.exec(`ALTER TABLE tasks DROP COLUMN queued_at;
    ALTER TABLE tasks RENAME TO cards;
    ALTER TABLE task_events RENAME TO card_events;
    ALTER TABLE cards RENAME COLUMN hermes_task_id TO hermes_card_id;
    ALTER TABLE card_events RENAME COLUMN task_id TO card_id;
    ALTER TABLE review_results RENAME COLUMN task_id TO card_id;
    ALTER TABLE factory_threads RENAME COLUMN task_id TO card_id;
    ALTER TABLE factory_launches RENAME COLUMN task_id TO card_id;
    ALTER TABLE issues RENAME COLUMN task_id TO card_id;
    ALTER TABLE merges RENAME COLUMN task_id TO card_id;
    ALTER TABLE notifications RENAME COLUMN task_id TO card_id;
    DROP INDEX task_events_by_task;
    CREATE INDEX card_events_by_card ON card_events (card_id, id);`);
}

/** Puts a current database back into the shape it had before tasks could be parked. */
/** Puts a current database back into the shape it had before threads recorded their effort. */
function backToBeforeEffort(db: Database): void {
  db.exec(`ALTER TABLE factory_threads DROP COLUMN effort;
    ALTER TABLE factory_launches DROP COLUMN effort;`);
}

/** Puts a current database back into the shape it had before project skills. */
function backToBeforeProjectSkills(db: Database): void {
  backToBeforeEffort(db);
  db.exec("ALTER TABLE worker_projects DROP COLUMN skills_cloned_at;");
}

function backToBeforeParking(db: Database): void {
  backToBeforeProjectSkills(db);
  db.exec(`ALTER TABLE tasks DROP COLUMN defer_until;
    ALTER TABLE tasks DROP COLUMN owner_question;`);
}

/** Puts a current database back into the shape it had before pending filings were kept. */
function backToBeforePendingIssues(db: Database): void {
  backToBeforeParking(db);
  db.exec("DROP TABLE pending_issues;");
}

/** Puts a current database back into the shape it had before version titles. */
function backToUntitledVersions(db: Database): void {
  backToBeforePendingIssues(db);
  db.exec("ALTER TABLE config_versions DROP COLUMN title;");
}

/** Puts a current database back into the shape it had before the lead's queue. */
function backToBeforeQueue(db: Database): void {
  backToUntitledVersions(db);
  db.exec(`ALTER TABLE tasks DROP COLUMN queue_order;
    ALTER TABLE tasks DROP COLUMN defer_reason;
    ALTER TABLE tasks DROP COLUMN defer_after;
    ALTER TABLE tasks DROP COLUMN defer_mark;
    ALTER TABLE tasks DROP COLUMN triage_since;
    ALTER TABLE tasks DROP COLUMN triage_alerted;
    ALTER TABLE tasks DROP COLUMN park_pending;
    ALTER TABLE tasks ADD COLUMN queued_at TEXT;`);
}

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("store migrations", () => {
  it("upgrades a database that already had the notification kind, backfilling what it lacked", () => {
    dir = mkdtempSync(join(tmpdir(), "hephaestus-store-"));
    const path = join(dir, "state.db");
    // Rebuild the state right after the kind column was added.
    let db = openStore(path);
    const latest = db.pragma("user_version", { simple: true }) as number;
    backToCardSchema(db);
    db.exec(`ALTER TABLE merges DROP COLUMN foreign_merge;
      ALTER TABLE issues DROP COLUMN closed;
      ALTER TABLE issues DROP COLUMN read_order;
      ALTER TABLE factory_threads DROP COLUMN settled_at;
      ALTER TABLE cards DROP COLUMN policy;
      DROP TABLE chat_changes;
      DROP TABLE chat_threads;
      DROP TABLE issue_attachments;
      ALTER TABLE factory_threads DROP COLUMN input_tokens;
      ALTER TABLE factory_threads DROP COLUMN output_tokens;
      ALTER TABLE factory_threads DROP COLUMN cost_usd;
      ALTER TABLE cards DROP COLUMN version;
      ALTER TABLE cards DROP COLUMN reverting;
      ALTER TABLE cards DROP COLUMN limit_until;
      ALTER TABLE cards DROP COLUMN limit_run;
      ALTER TABLE thread_items DROP COLUMN run_id;
      ALTER TABLE factory_threads DROP COLUMN latest_run_id;
      INSERT INTO notifications (at, card_id, text, kind)
      VALUES ('2026-11-25T12:00:00Z', 1, 'Card 1 needs you: approve the merge', 'info');
      INSERT INTO cards (id, repo, title, stage, created_at, updated_at)
      VALUES (1, 'octo/app', 'mid-revert', 'Escalated', 'x', 'x'),
             (2, 'octo/app', 'reverted, then retried', 'Escalated', 'x', 'x');
      INSERT INTO cards (id, repo, title, stage, brief, created_at, updated_at)
      VALUES (3, 'octo/app', 'started while paused', 'Admitted', 'brief', 'x', 'asked'),
             (4, 'octo/app', 'not started yet', 'Admitted', NULL, 'x', 'never');
      INSERT INTO card_events (card_id, at, kind, detail)
      VALUES (1, 'x', 'stage:Implementing', ''), (1, 'x', 'stage:Reverting', ''),
             (2, 'x', 'stage:Reverting', ''), (2, 'x', 'stage:Implementing', '');`);
    db.pragma(`user_version = ${String(latest - 22)}`);
    db.close();

    db = openStore(path);
    expect(db.prepare("SELECT kind FROM notifications").get()).toEqual({ kind: "escalation" });
    expect(db.prepare("SELECT id, reverting FROM tasks WHERE id <= 2 ORDER BY id").all()).toEqual([
      { id: 1, reverting: 1 },
      { id: 2, reverting: 0 },
    ]);
    // A start asked for while paused, before queues existed, goes to the queue.
    expect(
      db.prepare("SELECT id, stage, queue_order FROM tasks WHERE id > 2 ORDER BY id").all(),
    ).toEqual([
      { id: 3, stage: "Queued", queue_order: 1 },
      { id: 4, stage: "Admitted", queue_order: null },
    ]);
    expect(db.pragma("user_version", { simple: true })).toBe(latest);
    db.close();
  });
  it("renames cards to tasks and keeps every row, its links, and its history", () => {
    dir = mkdtempSync(join(tmpdir(), "hephaestus-store-"));
    const path = join(dir, "state.db");
    let db = openStore(path);
    const latest = db.pragma("user_version", { simple: true }) as number;
    backToCardSchema(db);
    db.exec(`INSERT INTO cards (id, repo, issue_number, title, stage, hermes_card_id, branch, reason, created_at, updated_at)
        VALUES (8, 'octo/app', 62, 'Rename the card', 'Implementing', 'kb-1', 'factory/0123abcd-card-8',
                'The card needs a discard step', 'x', 'x');
      INSERT INTO card_events (card_id, at, kind, detail)
        VALUES (8, 'x', 'stage:Implementing', 'Card 8 started on factory/0123abcd-card-8');
      INSERT INTO issues (repo, number, title, author, provenance, state, card_id, created_at, updated_at)
        VALUES ('octo/app', 62, 'Rename', 'me', 'external', 'admitted', 8, 'x', 'x');
      INSERT INTO review_results (card_id, head_sha, reviewer, author, verdict, thread_id, at)
        VALUES (8, 'abc', 'r', 'a', 'approve', 't9', 'x');
      INSERT INTO merges (repo, pr_number, merge_sha, card_id, at) VALUES ('octo/app', 70, 'def', 8, 'x');
      INSERT INTO notifications (at, card_id, text, kind)
        VALUES ('x', 8, 'Card 8 in octo/app needs you: the card is stuck', 'escalation');
      INSERT INTO factory_threads (environment_id, thread_id, title, provider_instance_id, model, config_version, card_id, kind, status, created_at, updated_at)
        VALUES ('env', 't1', 'Card 8: Rename the card', 'p', 'm', 1, '8', 'implement', 'running', 'x', 'x');
      INSERT INTO factory_launches (client_request_id, environment_id, title, provider_instance_id, model, config_version, card_id, kind, status, created_at, updated_at)
        VALUES ('hephaestus-implement-8-0', 'env', 'Card 8: Rename the card', 'p', 'm', 1, '8', 'implement', 'pending', 'x', 'x');
      INSERT INTO mcp_calls (role, tool, arguments, ok, result, at)
        VALUES ('lead', 'start_work', '{"card_id":8,"brief":"b"}', 1, '{"card_id":8,"stage":"Implementing"}', 'x'),
               ('lead', 'list_cards', '{}', 1, '[{"card_id":8,"title":"Rename the card"}]', 'x');`);
    db.pragma(`user_version = ${String(latest - 9)}`);
    db.close();

    db = openStore(path);
    expect(db.pragma("user_version", { simple: true })).toBe(latest);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%card%'").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM tasks").get()).toMatchObject({
      id: 8,
      issue_number: 62,
      stage: "Implementing",
      hermes_task_id: "kb-1",
      title: "Rename the task",
      // A branch is a name on GitHub, not text for the owner, so it keeps its old name.
      branch: "factory/0123abcd-card-8",
      reason: "The task needs a discard step",
    });
    expect(db.prepare("SELECT task_id, detail FROM task_events").all()).toEqual([
      { task_id: 8, detail: "Task 8 started on factory/0123abcd-card-8" },
    ]);
    expect(db.prepare("SELECT task_id FROM issues").all()).toEqual([{ task_id: 8 }]);
    expect(db.prepare("SELECT task_id FROM review_results").all()).toEqual([{ task_id: 8 }]);
    expect(db.prepare("SELECT task_id FROM merges").all()).toEqual([{ task_id: 8 }]);
    expect(db.prepare("SELECT task_id, text FROM notifications").all()).toEqual([
      { task_id: 8, text: "Task 8 in octo/app needs you: the task is stuck" },
    ]);
    expect(db.prepare("SELECT task_id, title FROM factory_threads").all()).toEqual([
      { task_id: "8", title: "Task 8: Rename the task" },
    ]);
    expect(db.prepare("SELECT task_id, title FROM factory_launches").all()).toEqual([
      { task_id: "8", title: "Task 8: Rename the task" },
    ]);
    expect(db.prepare("SELECT tool, arguments, result FROM mcp_calls ORDER BY id").all()).toEqual([
      {
        tool: "start_work",
        arguments: '{"task_id":8,"brief":"b"}',
        result: '{"task_id":8,"stage":"Implementing"}',
      },
      {
        tool: "list_tasks",
        arguments: "{}",
        result: '[{"task_id":8,"title":"Rename the task"}]',
      },
    ]);
    // The foreign key and the index follow the rename, so a new event links to its task and nothing else.
    const add = db.prepare(
      "INSERT INTO task_events (task_id, at, kind, detail) VALUES (?, 'x', 'k', '')",
    );
    expect(() => add.run(8)).not.toThrow();
    expect(() => add.run(99)).toThrow(/FOREIGN KEY/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'task_events_by_task'",
        )
        .all(),
    ).toHaveLength(1);
    db.close();
  });

  it("renames the planner to the communicator in stored state, and keeps the rest", () => {
    dir = mkdtempSync(join(tmpdir(), "hephaestus-store-"));
    const path = join(dir, "state.db");
    let db = openStore(path);
    const latest = db.pragma("user_version", { simple: true }) as number;
    const document = (key: string): string =>
      JSON.stringify({
        roles: { [key]: { persona: "Be brief.", skills: ["write-issue"] }, lead: { persona: "" } },
      });
    const seed = (): void => {
      db.exec("DELETE FROM config_versions");
      const add = db.prepare(
        "INSERT INTO config_versions (state, author, message, created_at, document) VALUES (?, 'owner', '', 'x', ?)",
      );
      add.run("superseded", document("planner"));
      add.run("deployed", document("planner"));
      db.exec(`INSERT OR REPLACE INTO hermes_skills (role, name) VALUES ('planner', 'write-issue'), ('lead', 'write-brief');
        INSERT OR REPLACE INTO hermes_cron_jobs (role, name, job_id) VALUES ('planner', 'daily', 'j1'), ('improver', 'nightly', 'j2');
        INSERT INTO mcp_calls (role, tool, arguments, ok, result, at) VALUES ('planner', 'file_issue', '{}', 1, '{}', 'x'), ('lead', 'start_work', '{}', 1, '{}', 'x');
        INSERT INTO chat_changes (target, summary, conversation, state, after_text, proposed_at)
          VALUES ('persona:planner', 's', 'c', 'proposed', 'a', 'x'), ('instruction:factory', 's', 'c', 'proposed', 'a', 'x');`);
      backToBeforeQueue(db);
      db.pragma(`user_version = ${String(latest - 7)}`);
    };
    const expectRenamed = (): void => {
      expect(db.pragma("user_version", { simple: true })).toBe(latest);
      const docs = db.prepare("SELECT document FROM config_versions ORDER BY id").all() as {
        document: string;
      }[];
      for (const row of docs) {
        expect(JSON.parse(row.document)).toEqual(JSON.parse(document("communicator")));
      }
      expect(db.prepare("SELECT role, name FROM hermes_skills ORDER BY role").all()).toEqual([
        { role: "communicator", name: "write-issue" },
        { role: "lead", name: "write-brief" },
      ]);
      expect(db.prepare("SELECT role, job_id FROM hermes_cron_jobs ORDER BY role").all()).toEqual([
        { role: "communicator", job_id: "j1" },
        { role: "improver", job_id: "j2" },
      ]);
      expect(db.prepare("SELECT role FROM mcp_calls ORDER BY id").all()).toEqual([
        { role: "communicator" },
        { role: "lead" },
      ]);
      expect(db.prepare("SELECT target FROM chat_changes ORDER BY id").all()).toEqual([
        { target: "persona:communicator" },
        { target: "instruction:factory" },
      ]);
    };

    // An upgraded install.
    seed();
    db.close();
    db = openStore(path);
    expectRenamed();
    // Run again over the renamed rows, as after a crash between the rename and the version bump.
    backToBeforeQueue(db);
    db.pragma(`user_version = ${String(latest - 7)}`);
    db.close();
    db = openStore(path);
    expectRenamed();
    db.close();
  });

  it("keeps threads recorded before effort, which read as launched with no effort set", () => {
    dir = mkdtempSync(join(tmpdir(), "hephaestus-store-"));
    const path = join(dir, "state.db");
    let db = openStore(path);
    const latest = db.pragma("user_version", { simple: true }) as number;
    backToBeforeEffort(db);
    db.exec(`INSERT INTO factory_threads (environment_id, thread_id, title, provider_instance_id, model,
        config_version, task_id, kind, status, created_at, updated_at)
      VALUES ('w1', 't1', 'Implement', 'hephaestus-claude', 'm', 1, '1', 'implement', 'completed', 'x', 'x')`);
    db.pragma(`user_version = ${String(latest - 1)}`);
    db.close();
    db = openStore(path);
    expect(db.pragma("user_version", { simple: true })).toBe(latest);
    expect(db.prepare("SELECT thread_id, effort FROM factory_threads").all()).toEqual([
      { thread_id: "t1", effort: null },
    ]);
    db.close();
  });

  it("keeps a worker's cloned projects through the upgrade that records clones with skills", () => {
    dir = mkdtempSync(join(tmpdir(), "hephaestus-store-"));
    const path = join(dir, "state.db");
    let db = openStore(path);
    const latest = db.pragma("user_version", { simple: true }) as number;
    backToBeforeProjectSkills(db);
    db.exec(
      "INSERT INTO worker_projects (environment_id, repo, project_id) VALUES ('w1', 'octo/app', 'p1')",
    );
    db.pragma(`user_version = ${String(latest - 2)}`);
    db.close();
    db = openStore(path);
    expect(db.pragma("user_version", { simple: true })).toBe(latest);
    // A clone from before is covered by the deploys since, so it holds nothing back.
    expect(db.prepare("SELECT project_id, skills_cloned_at FROM worker_projects").all()).toEqual([
      { project_id: "p1", skills_cloned_at: null },
    ]);
    db.close();
  });

  it("adds the table of pending filings to an installed database", () => {
    dir = mkdtempSync(join(tmpdir(), "hephaestus-store-"));
    const path = join(dir, "state.db");
    let db = openStore(path);
    const latest = db.pragma("user_version", { simple: true }) as number;
    backToBeforePendingIssues(db);
    db.pragma(`user_version = ${String(latest - 4)}`);
    db.close();
    db = openStore(path);
    expect(db.pragma("user_version", { simple: true })).toBe(latest);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pending_issues").get()).toEqual({ n: 0 });
    db.close();
  });

  it("takes an escalation to the owner from before parking as a question only when it was one", () => {
    dir = mkdtempSync(join(tmpdir(), "hephaestus-store-"));
    const path = join(dir, "state.db");
    let db = openStore(path);
    const latest = db.pragma("user_version", { simple: true }) as number;
    backToBeforeParking(db);
    db.exec(`INSERT INTO tasks (id, repo, title, stage, escalated_to, reason, owner_action, created_at, updated_at)
      VALUES (1, 'octo/app', 'handed on', 'Escalated', 'owner', 'Which format?', NULL, 'x', 'x'),
             (2, 'octo/app', 'held', 'Escalated', 'owner', 'It was put on hold on the Hermes board instead of being started', NULL, 'x', 'x'),
             (3, 'octo/app', 'merge to approve', 'Escalated', 'owner', 'strict policy', 'merge', 'x', 'x'),
             (4, 'octo/app', 'failed step', 'Escalated', 'owner', 'PR #5 comes from another repository', NULL, 'x', 'x'),
             (5, 'octo/app', 'with the lead', 'Escalated', 'lead', 'Which format?', NULL, 'x', 'x');
      INSERT INTO task_events (task_id, at, kind, detail)
      VALUES (1, 'x', 'stage:Escalated', 'to the lead: the implement thread asked a question'),
             (1, 'x', 'escalated:owner', 'Which format?'),
             (3, 'x', 'escalated:owner', 'an earlier question'),
             (3, 'x', 'stage:Escalated', 'to the owner: strict policy'),
             (4, 'x', 'stage:Escalated', 'to the owner: PR #5 comes from another repository'),
             (5, 'x', 'escalated:owner', 'Which format?');`);
    db.pragma(`user_version = ${String(latest - 3)}`);
    db.close();

    db = openStore(path);
    expect(db.pragma("user_version", { simple: true })).toBe(latest);
    expect(
      db.prepare("SELECT id, owner_question, defer_until FROM tasks ORDER BY id").all(),
    ).toEqual([
      { id: 1, owner_question: 1, defer_until: null },
      { id: 2, owner_question: 1, defer_until: null },
      { id: 3, owner_question: 0, defer_until: null },
      { id: 4, owner_question: 0, defer_until: null },
      { id: 5, owner_question: 0, defer_until: null },
    ]);
    db.close();
  });

  it("moves a task that never launched a thread into the queue, oldest request first", () => {
    dir = mkdtempSync(join(tmpdir(), "hephaestus-store-"));
    const path = join(dir, "state.db");
    let db = openStore(path);
    const latest = db.pragma("user_version", { simple: true }) as number;
    backToBeforeQueue(db);
    db.exec(`INSERT INTO tasks (id, repo, title, stage, brief, implement_thread, started_at, worker_env, waiting, queued_at, created_at, updated_at)
      VALUES (1, 'octo/app', 'waiting for a thread', 'Implementing', 'b', NULL, NULL, 'w1', 'The limit is reached.', NULL, 'x', '2026-11-25T12:03:00Z'),
             (2, 'octo/app', 'running', 'Implementing', 'b', 't1', 'x', 'w1', NULL, NULL, 'x', 'x'),
             (3, 'octo/app', 'launch reply lost', 'Implementing', 'b', NULL, NULL, 'w1', NULL, NULL, 'x', 'x'),
             (4, 'octo/app', 'waiting for a task slot', 'Admitted', 'b', NULL, NULL, NULL, 'The limit is reached.', '2026-11-25T12:01:00Z', 'x', 'x'),
             (5, 'octo/app', 'untriaged', 'Admitted', NULL, NULL, NULL, NULL, NULL, NULL, 'x', 'x'),
             (6, 'octo/app', 'restarted, waiting for a slot', 'Implementing', 'b', NULL, 'x', 'w1', NULL, NULL, 'x', 'x'),
             (7, 'octo/app', 'launched before a crash', 'Implementing', 'b', NULL, NULL, 'w1', NULL, NULL, 'x', 'x'),
             (8, 'octo/app', 'launch refused', 'Implementing', 'b', NULL, NULL, 'w1', NULL, NULL, 'x', '2026-11-25T12:05:00Z');
      INSERT INTO factory_launches (client_request_id, environment_id, title, provider_instance_id, model, config_version, task_id, status, created_at, updated_at)
      VALUES ('hephaestus-implement-3-0', 'w1', 'Task 3', 'p', 'm', 1, '3', 'pending', 'x', 'x'),
             ('hephaestus-implement-7-0', 'w1', 'Task 7', 'p', 'm', 1, '7', 'launched', 'x', 'x'),
             ('hephaestus-implement-8-0', 'w1', 'Task 8', 'p', 'm', 1, '8', 'failed', 'x', 'x');`);
    db.pragma(`user_version = ${String(latest - 6)}`);
    db.close();

    db = openStore(path);
    expect(
      db
        .prepare(
          "SELECT id, stage, queue_order, worker_env, waiting, park_pending FROM tasks ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: 1, stage: "Queued", queue_order: 2, worker_env: null, waiting: null, park_pending: 1 },
      {
        id: 2,
        stage: "Implementing",
        queue_order: null,
        worker_env: "w1",
        waiting: null,
        park_pending: 0,
      },
      {
        id: 3,
        stage: "Implementing",
        queue_order: null,
        worker_env: "w1",
        waiting: null,
        park_pending: 0,
      },
      { id: 4, stage: "Queued", queue_order: 1, worker_env: null, waiting: null, park_pending: 1 },
      {
        id: 5,
        stage: "Admitted",
        queue_order: null,
        worker_env: null,
        waiting: null,
        park_pending: 0,
      },
      {
        id: 6,
        stage: "Implementing",
        queue_order: null,
        worker_env: "w1",
        waiting: null,
        park_pending: 0,
      },
      {
        id: 7,
        stage: "Implementing",
        queue_order: null,
        worker_env: "w1",
        waiting: null,
        park_pending: 0,
      },
      // A refused launch pins the task to its worker.
      { id: 8, stage: "Queued", queue_order: 3, worker_env: "w1", waiting: null, park_pending: 1 },
    ]);
    expect(
      db
        .prepare("SELECT task_id FROM task_events WHERE kind = 'stage:Queued' ORDER BY task_id")
        .all(),
    ).toEqual([{ task_id: 1 }, { task_id: 4 }, { task_id: 8 }]);
    db.close();
  });

  it("keeps the versions saved before titles, which read with a title made from their message", () => {
    dir = mkdtempSync(join(tmpdir(), "hephaestus-store-"));
    const path = join(dir, "state.db");
    let db = openStore(path);
    const latest = db.pragma("user_version", { simple: true }) as number;
    backToUntitledVersions(db);
    db.exec(`INSERT INTO config_versions (state, author, message, created_at, document)
      VALUES ('draft', 'improver', 'Tighten the review skill. It missed two failing tests.', 'x', '{}');`);
    db.pragma(`user_version = ${String(latest - 5)}`);
    db.close();

    db = openStore(path);
    expect(db.pragma("user_version", { simple: true })).toBe(latest);
    const version = new ConfigStore(db).get(1);
    expect(version).toMatchObject({
      title: "Tighten the review skill",
      message: "Tighten the review skill. It missed two failing tests.",
      state: "draft",
    });
    db.close();
  });

  it("starts a fresh install with nothing to rename", () => {
    dir = mkdtempSync(join(tmpdir(), "hephaestus-store-"));
    const db = openStore(join(dir, "state.db"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM config_versions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM mcp_calls").get()).toEqual({ n: 0 });
    db.close();
  });

  it("rewrites the word in stored text with its casing, and leaves other words alone", () => {
    expect(renameCardWords('Card 3 and cards 4: a card, (card) [card 5] "card"')).toBe(
      'Task 3 and tasks 4: a task, (task) [task 5] "task"',
    );
    expect(renameCardWords("discard the cardinal; branch factory/ab12-card-3; card_id")).toBe(
      "discard the cardinal; branch factory/ab12-card-3; card_id",
    );
    expect(renameCardWords('{"card_id":3,"cards_by_stage":{}}')).toBe(
      '{"task_id":3,"tasks_by_stage":{}}',
    );
    expect(renameCardWords(null)).toBeNull();
  });
});
