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
  it("marks old escalation notices on a database that already had the notification kind", () => {
    dir = mkdtempSync(join(tmpdir(), "hephaestus-store-"));
    const path = join(dir, "state.db");
    // Rebuild the state before the latest migration: the kind column exists, the later ones do not.
    let db = openStore(path);
    const latest = db.pragma("user_version", { simple: true }) as number;
    db.exec(`ALTER TABLE merges DROP COLUMN foreign_merge;
      ALTER TABLE issues DROP COLUMN closed;
      ALTER TABLE cards DROP COLUMN version;
      ALTER TABLE cards DROP COLUMN reverting;
      INSERT INTO notifications (at, card_id, text, kind)
      VALUES ('2026-11-25T12:00:00Z', 1, 'Card 1 needs you: approve the merge', 'info');`);
    db.pragma(`user_version = ${String(latest - 1)}`);
    db.close();

    db = openStore(path);
    expect(db.prepare("SELECT kind FROM notifications").get()).toEqual({ kind: "escalation" });
    expect(db.pragma("user_version", { simple: true })).toBe(latest);
    db.close();
  });
});
