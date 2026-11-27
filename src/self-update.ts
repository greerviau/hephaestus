import { readFileSync } from "node:fs";
import type { Run } from "./service.js";

/** The transient user unit a dashboard update runs in. */
export const UPDATE_UNIT = "hephaestus-update.service";
/** The line the unit's shell writes when `update` ends, which the page reads the result from. */
const FINISHED = /Update finished with exit code (\d+)\.\s*$/;
/** systemctl is-active answers for a unit that still runs or is being stopped. */
const RUNNING_STATES = new Set(["active", "activating", "deactivating", "reloading"]);
/** The most of the log the page shows: npm's output can be long. */
const MAX_LOG_BYTES = 64 * 1024;

export interface SelfUpdateStatus {
  running: boolean;
  /** The last run's output, when there was one. */
  log?: string;
  /** `update`'s exit code, once the last run finished. */
  exitCode?: number;
}

/**
 * Runs `hephaestus update` for the dashboard as a transient systemd user unit,
 * which outlives the restart of the service that started it. Its output goes
 * to a log file the update page reads.
 */
export class SelfUpdate {
  constructor(
    private readonly options: {
      run: Run;
      /** The node and CLI the service runs. */
      node: string;
      cli: string;
      logPath: string;
      /** PATH for the unit, so update finds git, npm, and systemctl as the service does. */
      path: string;
    },
  ) {}

  private running(): boolean {
    const state = this.options.run("systemctl", ["--user", "is-active", UPDATE_UNIT]);
    return RUNNING_STATES.has(state.stdout.trim());
  }

  /** Starts an update; throws with the reason when one runs already or systemd refuses. */
  start(): void {
    if (this.running()) throw new Error("An update is already running.");
    const { node, cli, logPath, path } = this.options;
    const started = this.options.run("systemd-run", [
      "--user",
      `--unit=${UPDATE_UNIT}`,
      // The unit is removed when it ends, so the next update can reuse its name.
      "--collect",
      "--quiet",
      `--property=StandardOutput=truncate:${logPath}`,
      `--setenv=PATH=${path}`,
      "/bin/sh",
      "-c",
      '"$0" "$1" update; echo "Update finished with exit code $?."',
      node,
      cli,
    ]);
    if (started.status !== 0) {
      const detail = started.stderr?.trim() ?? "";
      throw new Error(`systemd did not start the update${detail === "" ? "." : `: ${detail}`}`);
    }
  }

  status(): SelfUpdateStatus {
    const running = this.running();
    let log: string;
    try {
      log = readFileSync(this.options.logPath, "utf8");
    } catch {
      return { running };
    }
    if (log.length > MAX_LOG_BYTES) log = log.slice(-MAX_LOG_BYTES);
    const finished = FINISHED.exec(log);
    return finished === null || running
      ? { running, log }
      : { running, log, exitCode: Number(finished[1]) };
  }
}
