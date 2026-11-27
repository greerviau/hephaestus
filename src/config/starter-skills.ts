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
  "write-issue": ["planner"],
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

/**
 * Proposes, as a draft version for the owner to approve, the starter skills this build ships
 * that the deployed version lacks, and new text for a starter skill the owner left as an
 * earlier build offered it. A skill the owner edited, or one of their own with the same name,
 * stays as it is. Each text is offered once, so a rejected offer does not come back. Returns
 * the draft, or undefined when there is nothing to offer or no version is deployed.
 */
export function offerStarterSkills(options: {
  db: Database;
  store: ConfigStore;
}): ConfigVersion | undefined {
  const { db, store } = options;
  const deployed = store.current();
  if (deployed?.state !== "deployed") return undefined;
  const offered = JSON.parse(getMeta(db, OFFERED_KEY) ?? "{}") as Record<string, string>;
  let document = deployed.document;
  const added: string[] = [];
  const updated: string[] = [];
  for (const skill of starterSkills()) {
    const digest = skillDigest(skill.files);
    if (offered[skill.name] === digest) continue;
    const have = Object.hasOwn(document.skills, skill.name)
      ? document.skills[skill.name]
      : undefined;
    if (have === undefined) {
      document = withStarterSkill(document, skill);
      added.push(skill.name);
    } else if (offered[skill.name] === skillDigest(have)) {
      document = structuredClone(document);
      document.skills[skill.name] = { ...skill.files };
      updated.push(skill.name);
    }
    offered[skill.name] = digest;
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
  }
  setMeta(db, OFFERED_KEY, JSON.stringify(offered));
  return draft;
}
