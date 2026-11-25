import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SERVICE_NAME } from "./paths.js";

/** First line of every unit Hephaestus writes. Uninstall removes only units that carry it. */
export const UNIT_MARKER = "# Written by `hephaestus install`. `hephaestus uninstall` removes it.";

export interface ServiceManager {
  /** Writes the unit, then enables and starts the service. Refuses an existing unit. */
  install(unit: string): void;
  /** Stops and disables the service, then deletes the unit. Succeeds when there is no unit. */
  remove(): void;
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
function quoteArgument(value: string): string {
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
}

export type Run = (command: string, args: string[]) => RunResult;

const runCommand: Run = (command, args) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout };
};

/** `systemctl is-active` answers that confirm no service process is running. */
const STOPPED_STATES = new Set(["inactive", "failed", "unknown"]);

/** Runs Hephaestus as a systemd user service. */
export class SystemdUserService implements ServiceManager {
  constructor(
    private readonly unitPath: string,
    private readonly run: Run = runCommand,
  ) {}

  install(unit: string): void {
    if (this.unitExists()) throw new UnitExistsError(this.unitPath);
    // systemd may load a unit of the same name from another folder; never act on that one.
    if (this.run("systemctl", ["--user", "cat", SERVICE_NAME]).status === 0) {
      throw new UnitExistsError(SERVICE_NAME);
    }
    mkdirSync(dirname(this.unitPath), { recursive: true });
    writeFileSync(this.unitPath, unit, { flag: "wx" });
    this.systemctl("daemon-reload");
    this.systemctl("enable", "--now", SERVICE_NAME);
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
    this.systemctl("disable", "--now", SERVICE_NAME);
    this.assertStopped();
    rmSync(this.unitPath);
    this.systemctl("daemon-reload");
  }

  private assertStopped(): void {
    const state = this.run("systemctl", ["--user", "is-active", SERVICE_NAME]).stdout.trim();
    if (!STOPPED_STATES.has(state)) {
      throw new Error(
        `${SERVICE_NAME} is still ${state || "in an unknown state"}; stop it and run uninstall again.`,
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
      throw new Error(`systemctl --user ${args.join(" ")} exited with ${String(result.status)}`);
    }
  }
}
