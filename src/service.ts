import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { basename } from "node:path";

/** First line of every unit Hephaestus writes. Uninstall removes only units that carry it. */
export const UNIT_MARKER = "# Written by `hephaestus install`. `hephaestus uninstall` removes it.";

export interface ServiceManager {
  /** Writes the unit, then enables and starts the service. Refuses an existing unit. */
  install(unit: string): void;
  /** Stops and disables the service, then deletes the unit. Succeeds when there is no unit. */
  remove(): void;
  /** Enables and starts a unit that is already installed. */
  start?(): void;
  /** Stops the service and leaves its unit in place. */
  stop?(): void;
}

export class UnitExistsError extends Error {
  constructor(path: string) {
    super(`${path} already exists. Hephaestus will not replace a unit it did not write.`);
  }
}

/**
 * Quotes one ExecStart argument so systemd passes it through unchanged. The
 * `:` prefix on the command turns off `$` expansion, so only `%` specifiers,
 * backslashes and quotes need escaping.
 */
export function quoteArgument(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`A unit path cannot contain a line break: ${value}`);
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  return `"${escaped}"`;
}

export function unitFile(nodePath: string, cliPath: string): string {
  return [
    UNIT_MARKER,
    "[Unit]",
    "Description=Hephaestus factory management layer",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=:${[nodePath, cliPath, "serve"].map(quoteArgument).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr?: string;
}

export type Run = (command: string, args: string[]) => RunResult;

const runCommand: Run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
};

/** `systemctl is-active` answers that confirm no service process is running. */
const STOPPED_STATES = new Set(["inactive", "failed", "unknown"]);

/** Runs Hephaestus as a systemd user service. */
export class SystemdUserService implements ServiceManager {
  /** The unit's name, taken from its file name, such as `hephaestus.service`. */
  private readonly name: string;

  constructor(
    private readonly unitPath: string,
    private readonly run: Run = runCommand,
  ) {
    this.name = basename(unitPath);
  }

  install(unit: string): void {
    if (this.unitExists()) throw new UnitExistsError(this.unitPath);
    // systemd may load a unit of the same name from another folder; never act on that one.
    if (this.run("systemctl", ["--user", "cat", this.name]).status === 0) {
      throw new UnitExistsError(this.name);
    }
    mkdirSync(dirname(this.unitPath), { recursive: true });
    writeFileSync(this.unitPath, unit, { flag: "wx" });
    this.systemctl("daemon-reload");
    this.systemctl("enable", "--now", this.name);
  }

  remove(): void {
    if (!this.unitExists()) {
      // The file can be gone while the service it started still runs.
      this.assertStopped();
      return;
    }
    if (!readFileSync(this.unitPath, "utf8").startsWith(UNIT_MARKER)) {
      throw new Error(`${this.unitPath} was not written by Hephaestus; leaving it in place.`);
    }
    this.systemctl("disable", "--now", this.name);
    this.assertStopped();
    rmSync(this.unitPath);
    this.systemctl("daemon-reload");
  }

  start(): void {
    if (!this.unitExists() || !readFileSync(this.unitPath, "utf8").startsWith(UNIT_MARKER)) {
      throw new Error(`${this.unitPath} is not a unit Hephaestus wrote.`);
    }
    this.systemctl("enable", "--now", this.name);
  }

  /** Restarts the service, so it rereads settings it loads only at start. */
  restart(): void {
    if (!this.unitExists() || !readFileSync(this.unitPath, "utf8").startsWith(UNIT_MARKER)) {
      throw new Error(`${this.unitPath} is not a unit Hephaestus wrote.`);
    }
    this.systemctl("restart", this.name);
  }

  stop(): void {
    if (!this.unitExists()) {
      this.assertStopped();
      return;
    }
    if (!readFileSync(this.unitPath, "utf8").startsWith(UNIT_MARKER)) {
      throw new Error(`${this.unitPath} was not written by Hephaestus; leaving it running.`);
    }
    // systemd may have loaded a unit of the same name from a directory that takes precedence.
    const loaded = this.run("systemctl", [
      "--user",
      "show",
      "-P",
      "FragmentPath",
      this.name,
    ]).stdout.trim();
    if (loaded !== "" && loaded !== this.unitPath) {
      throw new Error(
        `systemd runs ${this.name} from ${loaded}, not ${this.unitPath}; leaving it running.`,
      );
    }
    this.systemctl("stop", this.name);
    this.assertStopped();
  }

  private assertStopped(): void {
    const state = this.run("systemctl", ["--user", "is-active", this.name]).stdout.trim();
    if (!STOPPED_STATES.has(state)) {
      throw new Error(
        `${this.name} is still ${state || "in an unknown state"}; stop it and run uninstall again.`,
      );
    }
  }

  private unitExists(): boolean {
    try {
      lstatSync(this.unitPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private systemctl(...args: string[]): void {
    const result = this.run("systemctl", ["--user", ...args]);
    if (result.status !== 0) {
      const detail = result.stderr?.trim() ?? "";
      throw new Error(
        `systemctl --user ${args.join(" ")} exited with ${String(result.status)}${detail === "" ? "" : `: ${detail}`}`,
      );
    }
  }
}
