/**
 * Compatibility for the build that called the chat agent the planner. The agent is the
 * communicator now. Stored data is renamed once, when the state database and the factory Hermes
 * root are opened (see `renamePlannerInStore` and `migratePlannerFiles`), and the old role name
 * still works where an owner or an older prompt may type it, with a deprecation warning. Remove
 * the accepted old names one release after this ships; keep the one-time renames for installs
 * that skip releases.
 */
import { lstatSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import type { SecretsFile } from "./config/secrets.js";
import type { HermesRun } from "./hermes/cli.js";

export const LEGACY_ROLE = "planner";
export const CHAT_ROLE_NAME = "communicator";

/** Names of the stored MCP token secret before and after the rename. */
const tokenSecret = (role: string): string => `hermes-mcp-token-${role}`;

/** Logs that an old name was used, and what replaces it. */
export function warnDeprecated(old: string, replacement: string): void {
  console.warn(
    `${old} is deprecated and will stop working in a later release; use ${replacement}.`,
  );
}

/** The current name for a role the caller named, and the old name accepted with a warning. */
export function currentRoleName(name: string): string {
  if (name !== LEGACY_ROLE) return name;
  warnDeprecated(`The role name "${LEGACY_ROLE}"`, `"${CHAT_ROLE_NAME}"`);
  return CHAT_ROLE_NAME;
}

/**
 * Moves `roles.planner` of a config document to `roles.communicator`. A document that holds both
 * keeps the communicator's and drops the old one. Does not change its argument.
 */
export function renameLegacyRole<T>(value: T, warn = true): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const roles = (value as { roles?: unknown }).roles;
  if (typeof roles !== "object" || roles === null || !Object.hasOwn(roles, LEGACY_ROLE)) {
    return value;
  }
  if (warn) warnDeprecated(`The config key "roles.${LEGACY_ROLE}"`, `"roles.${CHAT_ROLE_NAME}"`);
  const { [LEGACY_ROLE]: legacy, ...rest } = roles as Record<string, unknown>;
  return {
    ...value,
    roles: {
      ...rest,
      [CHAT_ROLE_NAME]: Object.hasOwn(rest, CHAT_ROLE_NAME) ? rest[CHAT_ROLE_NAME] : legacy,
    },
  };
}

/**
 * Renames the role in everything the state database stored: each config version's document, the
 * recorded cron jobs, skills, and MCP calls, and the target of a change agreed in a chat. Safe to
 * run again.
 */
export function renamePlannerInStore(db: Database): void {
  const versions = db.prepare("SELECT id, document FROM config_versions").all() as {
    id: number;
    document: string;
  }[];
  const update = db.prepare("UPDATE config_versions SET document = ? WHERE id = ?");
  for (const { id, document } of versions) {
    const parsed = JSON.parse(document) as unknown;
    const renamed = renameLegacyRole(parsed, false);
    if (renamed !== parsed) update.run(JSON.stringify(renamed), id);
  }
  for (const table of ["hermes_cron_jobs", "hermes_skills"]) {
    // A row already under the new name wins; the old one is dropped.
    db.prepare(`UPDATE OR IGNORE ${table} SET role = ? WHERE role = ?`).run(
      CHAT_ROLE_NAME,
      LEGACY_ROLE,
    );
    db.prepare(`DELETE FROM ${table} WHERE role = ?`).run(LEGACY_ROLE);
  }
  db.prepare("UPDATE mcp_calls SET role = ? WHERE role = ?").run(CHAT_ROLE_NAME, LEGACY_ROLE);
  db.prepare("UPDATE chat_changes SET target = ? WHERE target = ?").run(
    `persona:${CHAT_ROLE_NAME}`,
    `persona:${LEGACY_ROLE}`,
  );
}

/** The factory gateway's service, as the profile move needs it. */
export interface GatewayControl {
  stopped(): boolean;
  stop(): void;
  start(): void;
}

/** Rekeys the gateway's sessions and routes from the old profile name to the new one. */
const MIGRATE_IDENTITY = ["profile", "migrate-identity", LEGACY_ROLE, CHAT_ROLE_NAME];

/**
 * Moves the old role's Hermes profile, with its skills, memories, and sessions, and its MCP
 * token secret to the new name. A profile that already exists under the new name is not
 * overwritten: the old one stays, and the log says so. Safe to run again.
 *
 * A running factory gateway serves the profile by its old name and holds its files open, so a
 * move under it leaves the gateway serving an empty profile at the old path and refusing the
 * moved one. The gateway is stopped for the move and started again after. Hermes keys the
 * Discord sessions and routes by profile name, so `run` rekeys them while the gateway is down.
 */
export async function migratePlannerFiles(options: {
  hermesRoot: string;
  secrets: SecretsFile;
  gateway?: GatewayControl;
  run?: HermesRun;
}): Promise<void> {
  const { hermesRoot, secrets, gateway, run } = options;
  const token = secrets.get(tokenSecret(LEGACY_ROLE));
  if (token !== undefined) {
    if (secrets.get(tokenSecret(CHAT_ROLE_NAME)) === undefined) {
      secrets.set(tokenSecret(CHAT_ROLE_NAME), token);
    }
    secrets.delete(tokenSecret(LEGACY_ROLE));
  }
  const from = join(hermesRoot, "profiles", LEGACY_ROLE);
  const to = join(hermesRoot, "profiles", CHAT_ROLE_NAME);
  // lstat, so a dangling link is still seen and moved as it is.
  const present = (path: string): boolean => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  };
  if (!present(from)) return;
  if (present(to)) {
    console.warn(
      `The Hermes profile ${LEGACY_ROLE} was not moved to ${CHAT_ROLE_NAME}, which already exists. Move its skills, memories, and sessions by hand.`,
    );
    return;
  }
  const wasRunning = gateway !== undefined && !gateway.stopped();
  if (wasRunning) gateway.stop();
  try {
    renameSync(from, to);
    if (run !== undefined) {
      try {
        await run(MIGRATE_IDENTITY);
      } catch (error) {
        console.warn(
          `The Hermes profile ${LEGACY_ROLE} moved to ${CHAT_ROLE_NAME}, but its Discord threads still route to the old name (${String(error)}). Run \`hermes ${MIGRATE_IDENTITY.join(" ")}\` with HERMES_HOME=${hermesRoot}.`,
        );
      }
    }
  } finally {
    if (wasRunning) gateway.start();
  }
}
