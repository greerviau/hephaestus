import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigStore, ConfigVersion } from "./store.js";

const BACKUP_FILE = /^config-\d{4}-\d{2}-\d{2}\.json$/;
export const DEFAULT_BACKUPS_KEPT = 14;
export const BACKUP_HOUR = 3;

interface BackupFile {
  format: "hephaestus-config-backup";
  version: 1;
  takenAt: string;
  versions: ConfigVersion[];
}

/**
 * Writes every config version to `config-<UTC date>.json` in `dir` and deletes
 * all but the newest `keep` backups. The secrets file is not included.
 */
export function backupVersions(
  store: ConfigStore,
  dir: string,
  now: Date,
  keep = DEFAULT_BACKUPS_KEPT,
): string {
  const backup: BackupFile = {
    format: "hephaestus-config-backup",
    version: 1,
    takenAt: now.toISOString(),
    versions: store.exportVersions(),
  };
  const path = join(dir, `config-${now.toISOString().slice(0, 10)}.json`);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(backup)}\n`, { mode: 0o600 });
  renameSync(temporary, path);

  const backups = readdirSync(dir)
    .filter((name) => BACKUP_FILE.test(name))
    .sort();
  for (const name of backups.slice(0, Math.max(0, backups.length - keep))) {
    rmSync(join(dir, name));
  }
  return path;
}

/** Restores a backup into an empty store and returns the number of versions loaded. */
export function restoreVersions(store: ConfigStore, file: string): number {
  const backup = JSON.parse(readFileSync(file, "utf8")) as Partial<BackupFile>;
  if (backup.format !== "hephaestus-config-backup" || !Array.isArray(backup.versions)) {
    throw new Error(`${file} is not a Hephaestus config backup.`);
  }
  store.importVersions(backup.versions);
  return backup.versions.length;
}

/** The next 03:00 local time after `now`. */
export function nextBackupAt(now: Date): Date {
  const next = new Date(now);
  next.setHours(BACKUP_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

/**
 * Backs up the config store into `dir` at every 03:00 local time until the
 * returned function is called. A failed backup is logged and retried the next night.
 */
export function scheduleBackups(store: ConfigStore, dir: string): () => void {
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    const now = new Date();
    timer = setTimeout(
      () => {
        try {
          backupVersions(store, dir, new Date());
        } catch (error) {
          console.error("Nightly config backup failed", error);
        }
        arm();
      },
      nextBackupAt(now).getTime() - now.getTime(),
    );
    timer.unref();
  };
  arm();
  return () => {
    clearTimeout(timer);
  };
}
