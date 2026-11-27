import { defineOwn } from "./diff.js";
import {
  ConfigValidationError,
  ROLE_NAMES,
  insideFileProblem,
  isSafeRelativePath,
  pathsInsideFiles,
  type FactoryConfig,
  type RoleName,
} from "./document.js";

/**
 * The instructions an agent starts with and the skills it loads. Each Hermes
 * role is one set; `threads` is what every implement and review thread gets.
 */
export const INSTRUCTION_SETS = [...ROLE_NAMES, "threads"] as const;
export type InstructionSetName = (typeof INSTRUCTION_SETS)[number];

/** The key in `FactoryConfig.instructions` that factory threads read. */
const THREAD_INSTRUCTIONS = "factory";

export interface InstructionSet {
  text: string;
  /** Names of skills in `FactoryConfig.skills`. */
  skills: string[];
}

export function isInstructionSet(name: string): name is InstructionSetName {
  return (INSTRUCTION_SETS as readonly string[]).includes(name);
}

export function instructionSet(config: FactoryConfig, name: InstructionSetName): InstructionSet {
  if (name === "threads") {
    return {
      text: config.instructions[THREAD_INSTRUCTIONS] ?? "",
      skills: config.factory.threadSkills,
    };
  }
  const role: RoleName = name;
  return { text: config.roles[role].persona, skills: config.roles[role].skills };
}

/** A copy of `config` with one instruction set replaced. */
export function withInstructionSet(
  config: FactoryConfig,
  name: InstructionSetName,
  set: InstructionSet,
): FactoryConfig {
  const next = structuredClone(config);
  if (name === "threads") {
    next.instructions[THREAD_INSTRUCTIONS] = set.text;
    next.factory.threadSkills = [...set.skills];
  } else {
    next.roles[name] = { ...next.roles[name], persona: set.text, skills: [...set.skills] };
  }
  return next;
}

/** The instruction sets that load `skill`. */
export function skillUsers(config: FactoryConfig, skill: string): InstructionSetName[] {
  return INSTRUCTION_SETS.filter((name) => instructionSet(config, name).skills.includes(skill));
}

/** A skill's files, or undefined when the config has no skill of that name. */
export function skillFiles(
  config: FactoryConfig,
  name: string,
): Record<string, string> | undefined {
  return Object.hasOwn(config.skills, name) ? config.skills[name] : undefined;
}

/** The `description` in a SKILL.md's front matter, when it is a single line. */
export function skillDescription(files: Record<string, string>): string | undefined {
  const text = Object.hasOwn(files, "SKILL.md") ? (files["SKILL.md"] ?? "") : "";
  const front = /^---\n([\s\S]*?)\n---(\n|$)/.exec(text)?.[1];
  const raw =
    front === undefined ? undefined : /^description:[ \t]*(.*)$/m.exec(front)?.[1]?.trim();
  if (raw === undefined || raw === "" || /^[|>]/.test(raw)) return undefined;
  if (raw.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Not a quoted string Hephaestus can read; show it as written.
    }
  }
  const single = /^'(.*)'$/.exec(raw)?.[1];
  return single === undefined ? raw : single.replaceAll("''", "'");
}

function refuse(problem: string): never {
  throw new ConfigValidationError([problem]);
}

function requireSkill(config: FactoryConfig, name: string): Record<string, string> {
  return skillFiles(config, name) ?? refuse(`There is no skill named ${name}.`);
}

function requireFree(config: FactoryConfig, name: string): void {
  if (Object.hasOwn(config.skills, name)) refuse(`A skill named ${name} already exists.`);
}

/** A value for a front matter line: plain when YAML reads it back as the same text, else quoted. */
function yamlScalar(text: string): string {
  return /^[A-Za-z0-9][^:#"'\\]*$/.test(text) && text.trim() === text ? text : JSON.stringify(text);
}

/** A copy of `config` with a new skill whose SKILL.md carries its name and description. */
export function withNewSkill(
  config: FactoryConfig,
  name: string,
  description: string,
): FactoryConfig {
  requireFree(config, name);
  const next = structuredClone(config);
  const oneLine = description.replace(/\s+/g, " ").trim();
  defineOwn(next.skills, name, {
    "SKILL.md": `---\nname: ${name}\n${oneLine === "" ? "" : `description: ${yamlScalar(oneLine)}\n`}---\n\n# ${name}\n`,
  });
  return next;
}

/**
 * Why `path` cannot be a file of the skill, or undefined when it can: it must
 * stay in the skill folder, and no file can lie inside another file. The
 * config's own validation refuses the same, for edits made as JSON.
 */
export function skillPathProblem(
  config: FactoryConfig,
  name: string,
  path: string,
): string | undefined {
  if (!isSafeRelativePath(path)) {
    return `skills.${name}.${JSON.stringify(path)} must be a relative path`;
  }
  const others = Object.keys(skillFiles(config, name) ?? {}).filter((other) => other !== path);
  const [clash] = pathsInsideFiles([...others, path]);
  return clash === undefined ? undefined : insideFileProblem(name, ...clash);
}

/** A copy of `config` with one file of a skill written, which creates the file when it is new. */
export function withSkillFile(
  config: FactoryConfig,
  name: string,
  path: string,
  text: string,
): FactoryConfig {
  requireSkill(config, name);
  const problem = skillPathProblem(config, name, path);
  if (problem !== undefined) refuse(problem);
  const next = structuredClone(config);
  defineOwn(requireSkill(next, name), path, text);
  return next;
}

function replaceIn(config: FactoryConfig, change: (skills: string[]) => string[]): void {
  config.factory.threadSkills = change(config.factory.threadSkills);
  for (const role of ROLE_NAMES) config.roles[role].skills = change(config.roles[role].skills);
}

/**
 * A copy of `config` with a skill renamed: its place in the list, every
 * instruction set that loads it, and the `name` in its SKILL.md when that
 * was the old name.
 */
export function withSkillRenamed(config: FactoryConfig, from: string, to: string): FactoryConfig {
  requireSkill(config, from);
  if (to === from) refuse(`The skill is already named ${to}.`);
  requireFree(config, to);
  const next = structuredClone(config);
  const skills: Record<string, Record<string, string>> = {};
  for (const [name, files] of Object.entries(next.skills)) {
    defineOwn(skills, name === from ? to : name, files);
  }
  next.skills = skills;
  const files = requireSkill(next, to);
  const front = /^---\n[\s\S]*?\n---(\n|$)/.exec(files["SKILL.md"] ?? "")?.[0];
  if (front !== undefined) {
    const named = front.replace(/^name:[ \t]*(.*)$/m, (line, old: string) =>
      [from, `"${from}"`, `'${from}'`].includes(old.trim()) ? `name: ${to}` : line,
    );
    defineOwn(files, "SKILL.md", named + (files["SKILL.md"] ?? "").slice(front.length));
  }
  replaceIn(next, (loaded) => loaded.map((skill) => (skill === from ? to : skill)));
  return next;
}

/** A copy of `config` without a skill, unloaded from every instruction set that loaded it. */
export function withoutSkill(config: FactoryConfig, name: string): FactoryConfig {
  requireSkill(config, name);
  const next = structuredClone(config);
  Reflect.deleteProperty(next.skills, name);
  replaceIn(next, (loaded) => loaded.filter((skill) => skill !== name));
  return next;
}
