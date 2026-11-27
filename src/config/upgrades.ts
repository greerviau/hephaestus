import type { Database } from "better-sqlite3";
import { getMeta, setMeta } from "../meta.js";
import { shippedPersona } from "./defaults.js";
import type { RoleName } from "./document.js";
import type { ConfigStore } from "./store.js";

/**
 * Persona texts that earlier releases shipped, by role. An install made then
 * keeps its persona in its config versions, so a newer template reaches it
 * only through an upgrade, and only while the persona is still the stock text.
 */
export const LEGACY_PERSONAS: Partial<Record<RoleName, readonly string[]>> & {
  planner: readonly string[];
} = {
  planner: [
    // The planner that only turned requests into issues.
    [
      "You are the planner for a software factory run by Hephaestus.\n\n",
      "Turn each request in your channel into one or more GitHub issues on a factory project. Each issue states the problem, the proposed approach when one is known, and numbered acceptance criteria that a reviewer can check.\n\n",
      "File issues only with the `file_issue` tool. Ask the requester when the goal or scope is unclear, and do not guess. Check `get_status` before filing, so you do not file a duplicate or pass the project's cap on open factory issues.\n\n",
      "When a request comes in a chat, reply in that conversation once you have filed its issues: link each issue, and include the `tracking` line that `file_issue` returns exactly as given, on a line of its own. Hephaestus finds the conversation by that line and posts the work's progress there, so you do not need to report progress yourself. Keep replies short, and never claim work is done before Hephaestus says so.\n",
    ].join(""),
  ],
};

interface PersonaUpgrade {
  /** Counted in order; the number applied is kept in the state database. */
  id: number;
  role: RoleName;
  message: string;
}

const PERSONA_UPGRADES: readonly PersonaUpgrade[] = [
  {
    id: 1,
    role: "planner",
    message:
      "Upgrade the planner persona to the general communicator, which still files issues when asked for work",
  },
];

const APPLIED_KEY = "template_upgrades_applied";
const PENDING_KEY = "template_upgrade_pending";

/** The upgrades a fresh install already has, because it starts from the current templates. */
export function markUpgradesApplied(db: Database): void {
  setMeta(db, APPLIED_KEY, String(PERSONA_UPGRADES.at(-1)?.id ?? 0));
}

/** Line ends and trailing space differ between files and the dashboard's text areas. */
function normalize(text: string): string {
  return text.replaceAll("\r\n", "\n").trimEnd();
}

export interface UpgradeOptions {
  db: Database;
  store: ConfigStore;
  /**
   * Publishes an approved version, or applies an already deployed one again, to the workers
   * and the factory Hermes root. It resolves with a `hermesError` when the version went out
   * but the factory Hermes root did not take it.
   */
  deploy: (id: number) => Promise<{ hermesError?: string }>;
}

/** Runs the deploy and says whether it went all the way, logging why when it did not. */
async function deployed(deploy: UpgradeOptions["deploy"], id: number): Promise<boolean> {
  try {
    const { hermesError } = await deploy(id);
    if (hermesError === undefined) return true;
    console.error(
      `Upgrade version ${String(id)} is deployed, but the factory Hermes root did not take it; it will be tried again`,
      hermesError,
    );
  } catch (error) {
    console.error(`Deploying upgrade version ${String(id)} failed; it will be tried again`, error);
  }
  return false;
}

/**
 * Replaces a role's persona with the shipped one when the current config still
 * has the stock persona an earlier release shipped. A persona the owner edited
 * is left alone. Each upgrade runs once, as a new version built on the current
 * one, so it can be reviewed and reverted like any other change. The version
 * and the markers are written together, so a crash cannot leave a version with
 * no marker or a marker with no version. A deploy that fails, or one that
 * leaves the factory Hermes root behind, is tried again at the next start
 * instead of making another version.
 */
export async function applyUpgrades({ db, store, deploy }: UpgradeOptions): Promise<void> {
  const pending = getMeta(db, PENDING_KEY);
  if (pending !== undefined && pending !== "") {
    const id = Number(pending);
    const version = store.get(id);
    let retry = false;
    if (version.state === "deployed") {
      // Deployed, but the factory Hermes root may not have taken it. Deploying a deployed
      // version again applies it to that root.
      retry = true;
    } else if (version.state === "approved") {
      try {
        store.assertDeployable(id);
        retry = true;
      } catch {
        // Built on a version that is no longer the deployed one.
      }
    }
    // A later version that is deployed has been applied to the factory Hermes root itself.
    if (retry && !(await deployed(deploy, id))) return;
    setMeta(db, PENDING_KEY, "");
  }

  for (const upgrade of PERSONA_UPGRADES) {
    if (upgrade.id <= Number(getMeta(db, APPLIED_KEY) ?? "0")) continue;
    const current = store.current();
    if (current === undefined) return;
    const persona = current.document.roles[upgrade.role].persona;
    const stock = (LEGACY_PERSONAS[upgrade.role] ?? []).some(
      (legacy) => normalize(legacy) === normalize(persona),
    );
    if (!stock) {
      setMeta(db, APPLIED_KEY, String(upgrade.id));
      continue;
    }
    const document = structuredClone(current.document);
    document.roles[upgrade.role].persona = shippedPersona(upgrade.role);
    const created = db.transaction(() => {
      const version = store.createVersion({
        document,
        author: "upgrade",
        message: upgrade.message,
        parentId: current.id,
      });
      store.approve(version.id);
      setMeta(db, APPLIED_KEY, String(upgrade.id));
      if (current.state === "deployed") setMeta(db, PENDING_KEY, String(version.id));
      return version.id;
    })();
    if (current.state === "deployed") {
      if (!(await deployed(deploy, created))) return;
      setMeta(db, PENDING_KEY, "");
    }
  }
}
