import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backupVersions,
  nextBackupAt,
  restoreVersions,
  scheduleBackups,
} from "../../src/config/backup.js";
import { ConfigStore } from "../../src/config/store.js";
import { openStore } from "../../src/store.js";
import { sampleConfig } from "./fixtures.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hephaestus-backup-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function populated(): ConfigStore {
  const store = new ConfigStore(openStore(":memory:"));
  const first = store.createVersion({
    document: sampleConfig(),
    author: "install",
    message: "First",
  });
  store.approve(first.id);
  store.markDeployed(first.id);
  const changed = sampleConfig();
  changed.roles.lead.persona = "Lead carefully.";
  store.createVersion({ document: changed, author: "improver", message: "Tune", parentId: 1 });
  return store;
}

describe("backup and restore", () => {
  it("round-trips every version with its state, author and parent", () => {
    const source = populated();

    const file = backupVersions(source, dir, new Date("2026-11-25T03:00:00Z"));
    const target = new ConfigStore(openStore(":memory:"));
    const count = restoreVersions(target, file);

    expect(count).toBe(2);
    expect(target.list()).toEqual(source.list());
    expect(target.diff(2)).toEqual(source.diff(2));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses to restore into a store that already has versions", () => {
    const file = backupVersions(populated(), dir, new Date("2026-11-25T03:00:00Z"));

    expect(() => restoreVersions(populated(), file)).toThrow(/empty/);
  });

  it("leaves a file that only looks like a backup", () => {
    const store = populated();
    writeFileSync(join(dir, "config-2000-01-01.json"), '{"mine": true}\n');
    for (let day = 1; day <= 3; day += 1) {
      backupVersions(store, dir, new Date(Date.UTC(2026, 10, day, 3)), 1);
    }

    expect(readdirSync(dir).sort()).toEqual(["config-2000-01-01.json", "config-2026-11-03.json"]);
  });

  it.each([
    [
      "an unsupported format version",
      { format: "hephaestus-config-backup", version: 2, versions: [] },
    ],
    [
      "a version that is its own parent",
      {
        format: "hephaestus-config-backup",
        version: 1,
        versions: [
          {
            id: 1,
            parentId: 1,
            state: "approved",
            author: "a",
            message: "",
            createdAt: "x",
            document: sampleConfig(),
          },
        ],
      },
    ],
  ])("refuses to restore %s", (_label, backup) => {
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify(backup));

    expect(() => restoreVersions(new ConfigStore(openStore(":memory:")), file)).toThrow();
  });

  it("keeps the newest backups and deletes older ones", () => {
    const store = populated();
    writeFileSync(join(dir, "unrelated.txt"), "keep me\n");
    for (let day = 1; day <= 16; day += 1) {
      backupVersions(store, dir, new Date(Date.UTC(2026, 10, day, 3)), 14);
    }

    const files = readdirSync(dir).sort();

    expect(files).toHaveLength(15);
    expect(files[0]).toBe("config-2026-11-03.json");
    expect(files).toContain("unrelated.txt");
  });
});

describe("nextBackupAt", () => {
  it("schedules the next backup at 03:00 local time", () => {
    const before = new Date(2026, 10, 25, 1, 30);
    const after = new Date(2026, 10, 25, 4, 0);

    expect(nextBackupAt(before)).toEqual(new Date(2026, 10, 25, 3, 0));
    expect(nextBackupAt(after)).toEqual(new Date(2026, 10, 26, 3, 0));
  });
});

describe("scheduleBackups", () => {
  it("writes a backup at each 03:00 until stopped", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 25, 2, 59) });
    try {
      const store = populated();
      const stop = scheduleBackups(store, dir);

      vi.advanceTimersByTime(60 * 1000);
      expect(readdirSync(dir)).toHaveLength(1);

      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(readdirSync(dir)).toHaveLength(2);

      stop();
      vi.advanceTimersByTime(48 * 60 * 60 * 1000);
      expect(readdirSync(dir)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
