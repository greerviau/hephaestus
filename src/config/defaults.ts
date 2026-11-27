import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { TextDecoder } from "node:util";
import { defineOwn } from "./diff.js";
import {
  DEFAULT_FACTORY,
  isSafeRelativePath,
  type FactoryConfig,
  type RoleConfig,
  type RoleName,
} from "./document.js";

/** The most text one skill file holds, in UTF-8 bytes, imported from a folder or typed on the Agents tab. */
export const MAX_SKILL_FILE_BYTES = 256 * 1024;

export interface ImportedSkill {
  name: string;
  files: Record<string, string>;
}

/**
 * The first config version: the imported skills, and empty owner instructions. The roles' and
 * coding threads' own instructions ship with Hephaestus (see shipped.ts).
 */
export function defaultConfig(skills: ImportedSkill[]): FactoryConfig {
  const role = (): RoleConfig => ({ persona: "", skills: [] });
  const roles: Record<RoleName, RoleConfig> = {
    planner: role(),
    lead: role(),
    improver: {
      ...role(),
      cron: [
        {
          name: "nightly",
          schedule: "30 2 * * *",
          prompt:
            "Run your nightly review of the day's factory threads and propose config changes.",
        },
      ],
    },
  };
  const names = new Set<string>();
  for (const skill of skills) {
    if (names.has(skill.name))
      throw new Error(`There are two skills named ${skill.name}; rename one folder.`);
    names.add(skill.name);
  }
  return {
    factory: structuredClone(DEFAULT_FACTORY),
    projects: {},
    roles,
    // The coding threads' own rules ship in the messages that start them.
    instructions: { factory: "" },
    skills: Object.fromEntries(skills.map((skill) => [skill.name, skill.files])),
  };
}

/** Reads a skill folder (one with a SKILL.md) as text files keyed by relative path. */
export function importSkill(dir: string): ImportedSkill {
  const files: Record<string, string> = {};
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const walk = (path: string): void => {
    for (const name of readdirSync(path).sort()) {
      const absolute = join(path, name);
      const stats = lstatSync(absolute);
      if (stats.isDirectory()) {
        walk(absolute);
        continue;
      }
      const key = relative(dir, absolute);
      if (!isSafeRelativePath(key))
        throw new Error(`Skill file ${key} must be a relative path without backslashes.`);
      if (!stats.isFile()) throw new Error(`Skill file ${key} is not a regular file.`);
      if (stats.size > MAX_SKILL_FILE_BYTES) throw new Error(`Skill file ${key} is over 256 KB.`);
      const bytes = readFileSync(absolute);
      let text: string;
      try {
        text = decoder.decode(bytes);
      } catch {
        throw new Error(`Skill file ${key} is not UTF-8 text.`);
      }
      if (text.includes("\0")) throw new Error(`Skill file ${key} is not text.`);
      defineOwn(files, key, text);
    }
  };
  walk(dir);
  if (!("SKILL.md" in files)) throw new Error(`${dir} has no SKILL.md, so it is not a skill.`);
  return { name: basename(dir), files };
}
