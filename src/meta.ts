import type { Database } from "better-sqlite3";

/** Small named values in the state database's `meta` table. */
export function getMeta(db: Database, key: string): string | undefined {
  return (
    db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined
  )?.value;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}
