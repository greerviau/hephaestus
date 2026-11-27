import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SelfUpdate, UPDATE_UNIT } from "../src/self-update.js";
import type { Run } from "../src/service.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hephaestus-self-update-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function updater(active: string, started = 0): { self: SelfUpdate; calls: string[][] } {
  const calls: string[][] = [];
  const run: Run = (command, args) => {
    calls.push([command, ...args]);
    if (args.includes("is-active"))
      return { status: active === "active" ? 0 : 3, stdout: `${active}\n` };
    return { status: started, stdout: "", stderr: started === 0 ? "" : "Unit already exists" };
  };
  const self = new SelfUpdate({
    run,
    node: "/opt/node/bin/node",
    cli: "/srv/hephaestus/dist/cli.js",
    logPath: join(dir, "update.log"),
    path: "/usr/bin:/bin",
  });
  return { self, calls };
}

describe("SelfUpdate", () => {
  it("runs update as a transient user unit of its own, logging to a file, so it outlives a restart", () => {
    const { self, calls } = updater("inactive");

    self.start();
    const launch = calls.find((call) => call[0] === "systemd-run");
    expect(launch).toEqual([
      "systemd-run",
      "--user",
      `--unit=${UPDATE_UNIT}`,
      "--collect",
      "--quiet",
      `--property=StandardOutput=truncate:${join(dir, "update.log")}`,
      "--setenv=PATH=/usr/bin:/bin",
      "/bin/sh",
      "-c",
      '"$0" "$1" update; echo "Update finished with exit code $?."',
      "/opt/node/bin/node",
      "/srv/hephaestus/dist/cli.js",
    ]);
  });

  it("refuses a second update while one runs, and says why systemd refused one", () => {
    expect(() => {
      updater("active").self.start();
    }).toThrow(/already running/);
    expect(() => {
      updater("inactive", 1).self.start();
    }).toThrow(/Unit already exists/);
  });

  it("reads the last run's log and tells a finished run from one that is still going", () => {
    const { self } = updater("inactive");
    expect(self.status()).toEqual({ running: false });

    writeFileSync(join(dir, "update.log"), "Fast-forwarded\nUpdate finished with exit code 0.\n");
    expect(self.status()).toEqual({
      running: false,
      log: "Fast-forwarded\nUpdate finished with exit code 0.\n",
      exitCode: 0,
    });
    expect(updater("active").self.status().running).toBe(true);
  });
});
