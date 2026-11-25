import { readFileSync, writeFileSync } from "node:fs";

export interface Config {
  host: string;
  port: number;
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
