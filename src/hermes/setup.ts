import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import type { Database } from "better-sqlite3";
import type { SecretsFile } from "../config/secrets.js";
import type { ConfigStore } from "../config/store.js";
import type { Paths } from "../paths.js";
import type { ServiceManager } from "../service.js";
import { FactoryBoard } from "./board.js";
import type { HermesRun } from "./cli.js";
import { gatewayUnitFile } from "./gateway.js";
import { installModelPlugin } from "./plugin.js";
import { FactoryProfiles, shippedInstructionsChanged } from "./profiles.js";

import { ROLE_NAMES, type RoleName } from "../config/document.js";
import { migratePlannerFiles, type GatewayControl } from "../legacy-planner.js";
import { join } from "node:path";

/** Each factory profile's bearer token for Hephaestus's MCP server. */
export function mcpTokenSecret(role: RoleName): string {
  return `hermes-mcp-token-${role}`;
}
const MCP_TOKEN_ENV = "HEPHAESTUS_MCP_TOKEN";

export interface SyncOptions {
  paths: Paths;
  store: ConfigStore;
  db: Database;
  secrets: SecretsFile;
  hermesPath: string;
  /** Runs `hermes` against the factory root. */
  run: HermesRun;
  /** The factory gateway's unit, and the path its file lives at. */
  service: ServiceManager & GatewayControl;
  gatewayUnitPath: string;
  /** Where the factory profiles reach Hephaestus's MCP server. */
  mcpUrl: string;
}

/**
 * Brings the factory Hermes root in line with the current config version:
 * root settings, the factory board, the three role profiles, and the
 * factory gateway's unit. Safe to run again; each step checks first.
 */
export async function syncFactoryHermes(options: SyncOptions): Promise<void> {
  const { paths, run } = options;
  mkdirSync(paths.hermes, { recursive: true, mode: 0o700 });
  const moved = await migratePlannerFiles({
    hermesRoot: paths.hermes,
    secrets: options.secrets,
    gateway: options.service,
    run,
  });
  const hermes = { root: paths.hermes, run };

  // Tasks move only through Hephaestus: no model-driven triage, and no Hermes
  // reviewer spawned for tasks sitting in `review`.
  await run(["config", "set", "kanban.auto_decompose", "false"]);
  await run(["config", "set", "kanban.review_dispatch", "false"]);
  await new FactoryBoard(hermes).ensure();
  await installModelPlugin(hermes);

  const version = options.store.current();
  if (version === undefined) throw new Error("There is no config version to apply.");
  const tokenFor = (role: RoleName): string => {
    let token = options.secrets.get(mcpTokenSecret(role));
    if (token === undefined) {
      token = randomBytes(32).toString("base64url");
      options.secrets.set(mcpTokenSecret(role), token);
    }
    return token;
  };
  await new FactoryProfiles(hermes, options.db).sync(version.document, version.id, (role) => ({
    url: options.mcpUrl,
    tokenEnv: MCP_TOKEN_ENV,
    token: tokenFor(role),
  }));

  if (existsSync(options.gatewayUnitPath)) {
    // A start that failed after the unit was written is retried here.
    options.service.start();
  } else {
    options.service.install(gatewayUnitFile(options.hermesPath, paths.hermes));
  }
  if (!moved) {
    throw new Error(
      "The planner's Hermes profile is not fully moved to the communicator; the log says what is left.",
    );
  }
}

/**
 * Applies the current config version to the factory Hermes root again when this build ships
 * role instructions the root has not been given, as after an update. A root without the role
 * profiles is not set up yet, and its first deploy brings them. A sync that fails leaves the
 * instructions unrecorded, so the next call tries again. Returns whether it synced; `sync`
 * returns why it failed, if it did.
 */
export async function applyShippedInstructions(options: {
  db: Database;
  store: ConfigStore;
  hermesRoot: string;
  sync: () => Promise<string | undefined>;
}): Promise<boolean> {
  const ready = ROLE_NAMES.every((role) => existsSync(join(options.hermesRoot, "profiles", role)));
  // The sync applies the current version, which is an approved one when none is deployed.
  const deployed = options.store.current()?.state === "deployed";
  if (!ready || !deployed || !shippedInstructionsChanged(options.db)) return false;
  const error = await options.sync();
  if (error !== undefined) console.error(`Applying the shipped role instructions failed: ${error}`);
  return true;
}
