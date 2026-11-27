import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { openStore, renameCardWords } from "../src/store.js";

/**
 * Puts a current database back into the shape it had before "card" became "task", so a test can
 * start an upgrade from an installed factory's schema. The old migrations are not kept as code,
 * so this is their last form: the same tables, columns, and index under their old names.
 */
function backToCardSchema(db: Database): void {
  db.exec(`ALTER TABLE tasks RENAME TO cards;
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
      INSERT INTO notifications (at, card_id, text, kind)
      VALUES ('2026-11-25T12:00:00Z', 1, 'Card 1 needs you: approve the merge', 'info');
      INSERT INTO cards (id, repo, title, stage, created_at, updated_at)
      VALUES (1, 'octo/app', 'mid-revert', 'Escalated', 'x', 'x'),
             (2, 'octo/app', 'reverted, then retried', 'Escalated', 'x', 'x');
      INSERT INTO card_events (card_id, at, kind, detail)
      VALUES (1, 'x', 'stage:Implementing', ''), (1, 'x', 'stage:Reverting', ''),
             (2, 'x', 'stage:Reverting', ''), (2, 'x', 'stage:Implementing', '');`);
    db.pragma(`user_version = ${String(latest - 12)}`);
    db.close();

    db = openStore(path);
    expect(db.prepare("SELECT kind FROM notifications").get()).toEqual({ kind: "escalation" });
    expect(db.prepare("SELECT id, reverting FROM tasks ORDER BY id").all()).toEqual([
      { id: 1, reverting: 1 },
      { id: 2, reverting: 0 },
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
    db.pragma(`user_version = ${String(latest - 1)}`);
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
