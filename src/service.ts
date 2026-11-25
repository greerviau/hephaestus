import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SERVICE_NAME } from "./paths.js";

export interface ServiceManager {
  /** Writes the unit, then enables and starts the service. */
  install(unit: string): void;
  /** Stops and disables the service, then deletes the unit. Succeeds when the service is already gone. */
  remove(): void;
}

export function unitFile(nodePath: string, cliPath: string): string {
  return [
    "[Unit]",
    "Description=Hephaestus factory management layer",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${nodePath} ${cliPath} serve`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export type Run = (command: string, args: string[]) => void;

const runCommand: Run = (command, args) => {
  execFileSync(command, args, { stdio: ["ignore", "inherit", "inherit"] });
};

/** Runs Hephaestus as a systemd user service. */
export class SystemdUserService implements ServiceManager {
  constructor(
    private readonly unitPath: string,
    private readonly run: Run = runCommand,
  ) {}

  install(unit: string): void {
    mkdirSync(dirname(this.unitPath), { recursive: true });
    writeFileSync(this.unitPath, unit);
    this.systemctl("daemon-reload");
    this.systemctl("enable", "--now", SERVICE_NAME);
  }

  remove(): void {
    try {
      this.systemctl("disable", "--now", SERVICE_NAME);
    } catch {
      // The unit may already be gone; removing the file below is what matters.
    }
    rmSync(this.unitPath, { force: true });
    this.systemctl("daemon-reload");
  }

  private systemctl(...args: string[]): void {
    this.run("systemctl", ["--user", ...args]);
  }
}
