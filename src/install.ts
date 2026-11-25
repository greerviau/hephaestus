import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { MIN_PASSWORD_LENGTH, hashPassword, writePasswordHash } from "./auth.js";
import { diffBaselines, takeBaseline, type Baseline, type Drift } from "./baseline.js";
import { DEFAULT_HOST, writeConfig } from "./config.js";
import type { Paths } from "./paths.js";
import { unitFile, type ServiceManager } from "./service.js";
import { openStore } from "./store.js";

export class AlreadyInstalledError extends Error {
  constructor(root: string) {
    super(`${root} already exists. Run \`hephaestus uninstall\` first.`);
  }
}

export class NotInstalledError extends Error {
  constructor(root: string) {
    super(`No install found: ${root} has no baseline.`);
  }
}

export interface InstallOptions {
  paths: Paths;
  service: ServiceManager;
  password: string;
  port: number;
  nodePath: string;
  cliPath: string;
}

export function install(options: InstallOptions): void {
  const { paths, service, password } = options;
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `The dashboard password must be at least ${String(MIN_PASSWORD_LENGTH)} characters.`,
    );
  }
  if (existsSync(paths.root)) throw new AlreadyInstalledError(paths.root);

  // Take the baseline before writing anything, so it reflects the owner's own state.
  const baseline = takeBaseline(paths.home);

  mkdirSync(paths.root, { mode: 0o700 });
  writeFileSync(paths.baseline, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });
  writeConfig(paths.config, { host: DEFAULT_HOST, port: options.port });
  const db = openStore(paths.state);
  try {
    writePasswordHash(db, hashPassword(password));
  } finally {
    db.close();
  }
  service.install(unitFile(options.nodePath, options.cliPath));
}

/** Removes the service and ~/.hephaestus, then returns every baseline entry that changed since install. */
export function uninstall({ paths, service }: { paths: Paths; service: ServiceManager }): Drift[] {
  if (!existsSync(paths.baseline)) throw new NotInstalledError(paths.root);
  const baseline = JSON.parse(readFileSync(paths.baseline, "utf8")) as Baseline;

  service.remove();
  rmSync(paths.root, { recursive: true, force: true });

  return diffBaselines(baseline, takeBaseline(paths.home));
}
