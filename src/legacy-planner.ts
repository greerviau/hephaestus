/**
 * Compatibility for the build that called the chat agent the planner. The agent is the
 * communicator now. Stored data is renamed once, when the state database and the factory Hermes
 * root are opened (see `renamePlannerInStore` and `migratePlannerFiles`), and the old role name
 * still works where an owner or an older prompt may type it, with a deprecation warning. Remove
 * the accepted old names one release after this ships; keep the one-time renames for installs
 * that skip releases.
 */
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import type { Database } from "better-sqlite3";
import type { SecretsFile } from "./config/secrets.js";
import type { HermesRun } from "./hermes/cli.js";
import { tryLock } from "./update.js";

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
  /** Running or starting, as opposed to stopped or stopping. */
  active(): boolean;
  stopped(): boolean;
  stop(): void;
  start(): void;
}

/** Rekeys the gateway's sessions and routes from the old profile name to the new one. */
const MIGRATE_IDENTITY = ["profile", "migrate-identity", LEGACY_ROLE, CHAT_ROLE_NAME];

/** What is left to do after the profile moved; kept until it is done, so a later run finishes. */
interface PendingMove {
  startGateway: boolean;
  rekey: boolean;
}

/** How long a run waits for another process's move to finish before giving up. */
const LOCK_WAIT_MS = 120_000;

/**
 * Moves the old role's Hermes profile, with its skills, memories, and sessions, and its MCP
 * token secret to the new name. A profile that already exists under the new name is not
 * overwritten: the old one stays, and the log says so. Safe to run again.
 *
 * A running factory gateway serves the profile by its old name and holds its files open, so a
 * move under it leaves the gateway serving an empty profile at the old path and refusing the
 * moved one. The gateway is stopped for the move and started again after. Hermes keys the
 * Discord sessions and routes by profile name, so `run` then rekeys them; Hermes does that with
 * the gateway running too. What is left to do is noted beside the Hermes root before the
 * gateway stops, and a later run finishes it, since by then the old profile is gone. The service
 * and `hermes sync` can both run this, so a lock beside the Hermes root keeps them apart. Without
 * `run` the profile is not moved, so its threads are never left on the old name.
 */
export async function migratePlannerFiles(options: {
  hermesRoot: string;
  secrets: SecretsFile;
  gateway?: GatewayControl;
  run?: HermesRun;
}): Promise<void> {
  const release = await waitForLock(join(dirname(options.hermesRoot), "hermes-profile-move.lock"));
  try {
    await movePlannerFiles(options);
  } finally {
    release();
  }
}

async function movePlannerFiles(options: {
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
  const pendingPath = join(dirname(hermesRoot), "hermes-profile-move.json");
  // lstat, so a dangling link is still seen and moved as it is.
  const present = (path: string): boolean => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  };
  if (present(from)) {
    if (present(to)) {
      console.warn(
        `The Hermes profile ${LEGACY_ROLE} was not moved to ${CHAT_ROLE_NAME}, which already exists. Move its skills, memories, and sessions by hand.`,
      );
      return;
    }
    if (run === undefined) {
      console.warn(
        `The Hermes profile ${LEGACY_ROLE} was not moved to ${CHAT_ROLE_NAME}: Hephaestus does not know where hermes is. Run \`hephaestus hermes sync --hermes <path>\` to move it.`,
      );
      return;
    }
    // A run that stopped the gateway and was cut off before the move left it to be started.
    const earlier = readPending(pendingPath);
    const startGateway = (gateway?.active() ?? false) || earlier?.startGateway === true;
    // Noted first, so a crash after the gateway stops or the profile moves still finishes later.
    writePending(pendingPath, { startGateway, rekey: true });
    let stoppedHere = false;
    try {
      if (gateway !== undefined && !gateway.stopped()) {
        gateway.stop();
        stoppedHere = true;
      }
      renameSync(from, to);
    } catch (error) {
      // Nothing moved, so nothing new is left to do. Only a gateway this run stopped is started
      // again; one it could not stop is left alone.
      if (earlier === undefined) rmSync(pendingPath, { force: true });
      if (startGateway && stoppedHere) gateway?.start();
      throw error;
    }
  }
  const pending = readPending(pendingPath);
  if (pending === undefined) return;
  if (pending.startGateway && gateway !== undefined) {
    try {
      gateway.start();
      pending.startGateway = false;
    } catch (error) {
      console.warn(
        `The Hermes profile moved to ${CHAT_ROLE_NAME}, but the factory gateway did not start again (${String(error)}). The next start of Hephaestus tries again.`,
      );
    }
  }
  if (pending.rekey && run !== undefined) {
    try {
      await run(MIGRATE_IDENTITY);
      pending.rekey = false;
    } catch (error) {
      console.warn(
        `The Hermes profile moved to ${CHAT_ROLE_NAME}, but its Discord threads still route to ${LEGACY_ROLE} (${String(error)}). The next start of Hephaestus tries again, or run \`hermes ${MIGRATE_IDENTITY.join(" ")}\` with HERMES_HOME=${hermesRoot}.`,
      );
    }
  }
  if (pending.startGateway || pending.rekey) writePending(pendingPath, pending);
  else rmSync(pendingPath, { force: true });
}

async function waitForLock(path: string): Promise<() => void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const release = tryLock(path);
    if (release !== undefined) return release;
    if (Date.now() > deadline) {
      throw new Error(`Another process is moving the Hermes profile. If none is, delete ${path}.`);
    }
    await sleep(200);
  }
}

/** Replaced in one step, so a crash never leaves half a file. */
function writePending(path: string, pending: PendingMove): void {
  const partial = `${path}.partial`;
  writeFileSync(partial, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
  renameSync(partial, path);
}

/**
 * The work left from an earlier run. A file that does not read as one still means the profile
 * moved, so the rekey, which is safe to repeat, is done again; the gateway is left as it is.
 */
function readPending(path: string): PendingMove | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const value = JSON.parse(text) as Partial<PendingMove>;
    if (typeof value.startGateway === "boolean" && typeof value.rekey === "boolean") {
      return { startGateway: value.startGateway, rekey: value.rekey };
    }
  } catch {
    // Read below as unknown.
  }
  console.warn(`${path} could not be read; the Discord threads are rekeyed again.`);
  return { startGateway: false, rekey: true };
}
