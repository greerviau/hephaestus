import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "../src/store.js";

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
    db.exec(`ALTER TABLE merges DROP COLUMN foreign_merge;
      ALTER TABLE issues DROP COLUMN closed;
      ALTER TABLE issues DROP COLUMN read_order;
      ALTER TABLE factory_threads DROP COLUMN settled_at;
      ALTER TABLE cards DROP COLUMN version;
      ALTER TABLE cards DROP COLUMN reverting;
      INSERT INTO notifications (at, card_id, text, kind)
      VALUES ('2026-11-25T12:00:00Z', 1, 'Card 1 needs you: approve the merge', 'info');
      INSERT INTO cards (id, repo, title, stage, created_at, updated_at)
      VALUES (1, 'octo/app', 'mid-revert', 'Escalated', 'x', 'x'),
             (2, 'octo/app', 'reverted, then retried', 'Escalated', 'x', 'x');
      INSERT INTO card_events (card_id, at, kind, detail)
      VALUES (1, 'x', 'stage:Implementing', ''), (1, 'x', 'stage:Reverting', ''),
             (2, 'x', 'stage:Reverting', ''), (2, 'x', 'stage:Implementing', '');`);
    db.pragma(`user_version = ${String(latest - 4)}`);
    db.close();

    db = openStore(path);
    expect(db.prepare("SELECT kind FROM notifications").get()).toEqual({ kind: "escalation" });
    expect(db.prepare("SELECT id, reverting FROM cards ORDER BY id").all()).toEqual([
      { id: 1, reverting: 1 },
      { id: 2, reverting: 0 },
    ]);
    expect(db.pragma("user_version", { simple: true })).toBe(latest);
    db.close();
  });
});
