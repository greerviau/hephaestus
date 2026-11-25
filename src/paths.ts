import { homedir } from "node:os";
import { join } from "node:path";

export const SERVICE_NAME = "hephaestus.service";

export interface Paths {
  home: string;
  root: string;
  config: string;
  state: string;
  baseline: string;
  unit: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.HOME ?? homedir();
  const root = join(home, ".hephaestus");
  const configHome = env.XDG_CONFIG_HOME ?? join(home, ".config");
  return {
    home,
    root,
    config: join(root, "config.json"),
    state: join(root, "state.db"),
    baseline: join(root, "baseline.json"),
    unit: join(configHome, "systemd", "user", SERVICE_NAME),
  };
}
