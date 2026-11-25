import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const SERVICE_NAME = "hephaestus.service";

export interface Paths {
  home: string;
  root: string;
  config: string;
  state: string;
  baseline: string;
  backups: string;
  secrets: string;
  unit: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.HOME ?? homedir();
  const root = join(home, ".hephaestus");
  // The XDG spec says to ignore an empty or relative XDG_CONFIG_HOME.
  const xdg = env.XDG_CONFIG_HOME;
  const configHome = xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".config");
  return {
    home,
    root,
    config: join(root, "config.json"),
    state: join(root, "state.db"),
    baseline: join(root, "baseline.json"),
    backups: join(root, "backups"),
    secrets: join(root, "secrets.json"),
    unit: join(configHome, "systemd", "user", SERVICE_NAME),
  };
}
