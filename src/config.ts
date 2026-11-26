import { readFileSync, writeFileSync } from "node:fs";

export interface Config {
  host: string;
  port: number;
  /** Sent in a response header so install can tell its own dashboard from another server on the port. */
  instanceId: string;
  /** The unit file install wrote; uninstall removes this one even if XDG_CONFIG_HOME changed since. */
  unitPath: string;
  /** The absolute path of the `t3` CLI at install, when it was on PATH. */
  t3Path?: string;
  /** T3's data directory when install ran with T3CODE_HOME set; the service has no such variable. */
  t3Home?: string;
  /** The absolute path of the `hermes` CLI at install, when it was on PATH. */
  hermesPath?: string;
  /** The absolute paths of `git` and `gh` at install, for the config repo. */
  gitPath?: string;
  ghPath?: string;
}

export const DEFAULT_PORT = 7700;
/** The dashboard is meant for the owner's LAN. */
export const DEFAULT_HOST = "0.0.0.0";

export function writeConfig(path: string, config: Config): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function readConfig(path: string): Config {
  return JSON.parse(readFileSync(path, "utf8")) as Config;
}

/** The short form of an install's id that names its config tags, card branches, and evidence refs. */
export function installPrefix(instanceId: string): string {
  return instanceId.slice(0, 8);
}
