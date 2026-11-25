import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  writePasswordHash,
} from "./auth.js";
import {
  diffBaselines,
  readBaseline,
  takeBaseline,
  type ConfigRoots,
  type Drift,
} from "./baseline.js";
import { DEFAULT_HOST, readConfig, writeConfig, type Config } from "./config.js";
import { defaultConfig, type ImportedSkill } from "./config/defaults.js";
import { ConfigStore } from "./config/store.js";
import type { Paths } from "./paths.js";
import { UnitExistsError, unitFile, type ServiceManager } from "./service.js";
import { openStore } from "./store.js";

export class AlreadyInstalledError extends Error {
  constructor(root: string) {
    super(`${root} already exists. Run \`hephaestus uninstall\` first.`);
  }
}

export class NotInstalledError extends Error {
  constructor(root: string) {
    super(`No Hephaestus install found: ${root} has no config.json written by install.`);
  }
}

export interface InstallOptions {
  paths: Paths;
  service: ServiceManager;
  password: string;
  port: number;
  nodePath: string;
  cliPath: string;
  /** Where the owner's tools keep their config; defaults to each tool's default folder. */
  roots?: ConfigRoots;
  /** Skills the owner chose to import into the first config version. */
  skills: ImportedSkill[];
  /** Resolves once this install's dashboard answers, and rejects if it never does. */
  waitForReady: (config: Config) => Promise<void>;
}

/**
 * Records the baseline, creates ~/.hephaestus, and starts the service. If any
 * step fails, it removes what it created and rethrows.
 */
export async function install(options: InstallOptions): Promise<void> {
  const { paths, service, password } = options;
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `The dashboard password must be at least ${String(MIN_PASSWORD_LENGTH)} characters.`,
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(
      `The dashboard password must be at most ${String(MAX_PASSWORD_LENGTH)} characters.`,
    );
  }
  if (existsSync(paths.root)) throw new AlreadyInstalledError(paths.root);

  // Take the baseline before writing anything, so it reflects the owner's own state.
  const baseline = takeBaseline(paths.home, options.roots);
  const config: Config = {
    host: DEFAULT_HOST,
    port: options.port,
    instanceId: randomUUID(),
    unitPath: paths.unit,
  };

  mkdirSync(paths.root, { mode: 0o700 });
  let serviceAttempted = false;
  try {
    // config.json goes first: uninstall treats it as proof that install created ~/.hephaestus.
    writeConfig(paths.config, config);
    writeFileSync(paths.baseline, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });
    const db = openStore(paths.state);
    try {
      writePasswordHash(db, hashPassword(password));
      const store = new ConfigStore(db);
      const first = store.createVersion({
        document: defaultConfig(options.skills),
        author: "install",
        message: "First version from the shipped templates and imported skills",
      });
      store.approve(first.id);
    } finally {
      db.close();
    }
    serviceAttempted = true;
    service.install(unitFile(options.nodePath, options.cliPath));
    await options.waitForReady(config);
  } catch (error) {
    if (serviceAttempted && !(error instanceof UnitExistsError)) {
      try {
        service.remove();
      } catch (cleanupError) {
        // Keep ~/.hephaestus, so `hephaestus uninstall` can finish the cleanup later.
        throw new Error(
          `${String(error)}. Removing the service afterwards also failed: ${String(cleanupError)}. ` +
            "Fix that, then run `hephaestus uninstall`.",
          { cause: cleanupError },
        );
      }
    }
    rmSync(paths.root, { recursive: true, force: true });
    throw error;
  }
}

export interface UninstallResult {
  /** Baseline entries that changed since install, or undefined when the baseline was unusable. */
  drift: Drift[] | undefined;
}

/**
 * Removes the service and ~/.hephaestus, and compares the owner's config with
 * the baseline taken at install. ~/.hephaestus stays in place if the service
 * cannot be removed or the comparison fails.
 */
export function uninstall({
  paths,
  service,
}: {
  paths: Paths;
  service: ServiceManager;
}): UninstallResult {
  if (!existsSync(paths.config)) throw new NotInstalledError(paths.root);
  const baseline = readBaseline(paths.baseline);

  service.remove();
  const drift =
    baseline === undefined
      ? undefined
      : diffBaselines(baseline, takeBaseline(paths.home, baseline.roots));
  rmSync(paths.root, { recursive: true, force: true });
  return { drift };
}

/** The unit path install recorded, so uninstall acts on the unit that install wrote. */
export function installedUnitPath(paths: Paths): string {
  if (!existsSync(paths.config)) throw new NotInstalledError(paths.root);
  return readConfig(paths.config).unitPath;
}
