import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import {
  isSafeRelativePath,
  type FactoryConfig,
  type RoleConfig,
  type RoleName,
} from "./document.js";

/** `templates/` in the repo; the same relative path works from `src/` and `dist/`. */
const TEMPLATES = fileURLToPath(new URL("../../templates/", import.meta.url));
const MAX_SKILL_FILE_BYTES = 256 * 1024;

export interface ImportedSkill {
  name: string;
  files: Record<string, string>;
}

function template(path: string): string {
  return readFileSync(join(TEMPLATES, path), "utf8");
}

/** The first config version: the shipped role templates and instructions, plus imported skills. */
export function defaultConfig(skills: ImportedSkill[]): FactoryConfig {
  const role = (name: RoleName): RoleConfig => ({
    persona: template(`roles/${name}.md`),
    skills: [],
  });
  const roles: Record<RoleName, RoleConfig> = {
    planner: role("planner"),
    lead: role("lead"),
    improver: role("improver"),
  };
  const names = new Set<string>();
  for (const skill of skills) {
    if (names.has(skill.name))
      throw new Error(`There are two skills named ${skill.name}; rename one folder.`);
    names.add(skill.name);
  }
  return {
    projects: {},
    roles,
    instructions: { factory: template("instructions/factory.md") },
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
      files[key] = text;
    }
  };
  walk(dir);
  if (!("SKILL.md" in files)) throw new Error(`${dir} has no SKILL.md, so it is not a skill.`);
  return { name: basename(dir), files };
}
