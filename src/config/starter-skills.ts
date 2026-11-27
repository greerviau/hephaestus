import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "better-sqlite3";
import { getMeta, setMeta } from "../meta.js";
import type { InstructionSetName } from "./agents.js";
import type { FactoryConfig } from "./document.js";
import type { ConfigStore, ConfigVersion } from "./store.js";

/** `templates/skills/` in the repo; the same relative path works from `src/` and `dist/`. */
const SKILLS = fileURLToPath(new URL("../../templates/skills/", import.meta.url));
/** The starter skills each build offered an install, by name, as {@link skillDigest} names them. */
const OFFERED_KEY = "starter_skills_offered";
/** Who a version that brings starter skills to an existing install is from. */
export const STARTER_AUTHOR = "hephaestus";

/**
 * The skills Hephaestus ships as a starting point, and the jobs that load each. Unlike the
 * shipped instructions, they are ordinary config: the owner edits, unloads, or deletes them.
 */
const LOADED_BY: Record<string, readonly InstructionSetName[]> = {
  "test-first": ["threads"],
  "find-root-cause": ["threads"],
  "resolve-conflicts": ["threads"],
  "review-pr": ["threads"],
  "write-issue": ["communicator"],
  "write-brief": ["lead"],
};

export interface StarterSkill {
  name: string;
  files: Record<string, string>;
  loadedBy: readonly InstructionSetName[];
}

function readFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(dir, path)] = readFileSync(path, "utf8");
  }
  return files;
}

/** The starter skills this build ships, in the order their jobs list them. */
export function starterSkills(): StarterSkill[] {
  return Object.entries(LOADED_BY).map(([name, loadedBy]) => ({
    name,
    files: readFiles(join(SKILLS, name)),
    loadedBy,
  }));
}

/** Identifies a skill's files, so an offer can tell a skill the owner left alone from one they edited. */
export function skillDigest(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) hash.update(`${path}\n${files[path] ?? ""}\n`);
  return hash.digest("hex");
}

/** A copy of `config` with `skill` in it and loaded by its jobs, keeping what the config already loads. */
export function withStarterSkill(config: FactoryConfig, skill: StarterSkill): FactoryConfig {
  const next = structuredClone(config);
  next.skills[skill.name] = { ...skill.files };
  for (const job of skill.loadedBy) {
    const loaded = job === "threads" ? next.factory.threadSkills : next.roles[job].skills;
    if (!loaded.includes(skill.name)) loaded.push(skill.name);
  }
  return next;
}

interface Offers {
  /** Starter skill texts the owner has decided on, by name: deployed, rejected, or installed. */
  decided: Record<string, string>;
  /** The draft waiting for the owner, and the texts it carries. */
  pending?: { id: number; skills: Record<string, string> };
}

function readOffers(db: Database): Offers {
  const raw = getMeta(db, OFFERED_KEY);
  return raw === undefined ? { decided: {} } : (JSON.parse(raw) as Offers);
}

/** Records the starter skills install put in version 1 as decided, so an update can update them. */
export function recordInstalledStarterSkills(db: Database, config: FactoryConfig): void {
  const offers = readOffers(db);
  for (const skill of starterSkills()) {
    const have = Object.hasOwn(config.skills, skill.name) ? config.skills[skill.name] : undefined;
    if (have !== undefined && skillDigest(have) === skillDigest(skill.files)) {
      offers.decided[skill.name] = skillDigest(skill.files);
    }
  }
  setMeta(db, OFFERED_KEY, JSON.stringify(offers));
}

/**
 * Proposes, as a draft version for the owner to approve, the starter skills this build ships
 * that the deployed version never had, and new text for a starter skill the owner left as an
 * earlier build offered it. A skill the owner edited, deleted, or never took, and one of their
 * own with the same name, stays as it is. A text counts as decided once its draft is deployed
 * or rejected; a draft left behind when another version was deployed is replaced by one built
 * on the deployed version. Returns the new draft, or undefined when there is nothing to offer.
 */
export function offerStarterSkills(options: {
  db: Database;
  store: ConfigStore;
}): ConfigVersion | undefined {
  const { db, store } = options;
  // One transaction, so a crash cannot file a draft without recording it.
  return db.transaction((): ConfigVersion | undefined => {
    const deployed = store.current();
    if (deployed?.state !== "deployed") return undefined;
    const offers = readOffers(db);
    if (offers.pending !== undefined) {
      const draft = store.get(offers.pending.id);
      if (
        draft.state === "deployed" ||
        draft.state === "superseded" ||
        draft.state === "rejected"
      ) {
        Object.assign(offers.decided, offers.pending.skills);
      } else if (draft.parentId === deployed.id) {
        return undefined;
      } else if (draft.state === "draft") {
        // Built on a version that is no longer deployed, it can never be deployed.
        store.reject(draft.id);
      }
      delete offers.pending;
    }
    let document = deployed.document;
    const added: string[] = [];
    const updated: string[] = [];
    const carried: Record<string, string> = {};
    for (const skill of starterSkills()) {
      const digest = skillDigest(skill.files);
      const decided = offers.decided[skill.name];
      if (decided === digest) continue;
      const have = Object.hasOwn(document.skills, skill.name)
        ? document.skills[skill.name]
        : undefined;
      if (have === undefined && decided === undefined) {
        document = withStarterSkill(document, skill);
        added.push(skill.name);
        carried[skill.name] = digest;
      } else if (have !== undefined && decided !== undefined && skillDigest(have) === decided) {
        document = structuredClone(document);
        document.skills[skill.name] = { ...skill.files };
        updated.push(skill.name);
        carried[skill.name] = digest;
      }
    }
    let draft: ConfigVersion | undefined;
    if (added.length > 0 || updated.length > 0) {
      const parts = [
        ...(added.length === 0 ? [] : [`add ${added.join(", ")}`]),
        ...(updated.length === 0 ? [] : [`update ${updated.join(", ")}`]),
      ];
      draft = store.createVersion({
        document,
        author: STARTER_AUTHOR,
        message: `Starter skills from Hephaestus: ${parts.join("; ")}`,
        parentId: deployed.id,
      });
      offers.pending = { id: draft.id, skills: carried };
    }
    setMeta(db, OFFERED_KEY, JSON.stringify(offers));
    return draft;
  })();
}
