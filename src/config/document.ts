import { POLICY_SETTING_NAMES, PRESET_NAMES, type Policy } from "./policy.js";

export const ROLE_NAMES = ["planner", "lead", "improver"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export interface RoleConfig {
  /** The role's instructions, used as the Hermes profile's persona. */
  persona: string;
  /** Names of skills in `FactoryConfig.skills` that the role loads. */
  skills: string[];
}

export interface ProjectConfig {
  policy: Policy;
}

/** The whole factory config. A config version is one snapshot of it. */
export interface FactoryConfig {
  /** Keyed by GitHub `owner/repo`. */
  projects: Record<string, ProjectConfig>;
  roles: Record<RoleName, RoleConfig>;
  /** Instruction files for factory threads, keyed by name. */
  instructions: Record<string, string>;
  /** Skills keyed by name, each a map from relative file path to text content. */
  skills: Record<string, Record<string, string>>;
}

export class ConfigValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid config: ${problems.join("; ")}`);
  }
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/;

/** Checks that a value is a FactoryConfig and returns it typed. */
export function validateConfig(value: unknown): FactoryConfig {
  const problems: string[] = [];
  const object = (path: string, v: unknown): Record<string, unknown> | undefined => {
    if (typeof v === "object" && v !== null && !Array.isArray(v))
      return v as Record<string, unknown>;
    problems.push(`${path} must be an object`);
    return undefined;
  };
  const string = (path: string, v: unknown): void => {
    if (typeof v !== "string") problems.push(`${path} must be a string`);
  };

  const root = object("config", value);
  if (root === undefined) throw new ConfigValidationError(problems);
  for (const key of Object.keys(root)) {
    if (!["projects", "roles", "instructions", "skills"].includes(key)) {
      problems.push(`config.${key} is not a config section`);
    }
  }

  const projects = object("projects", root.projects) ?? {};
  for (const [repo, project] of Object.entries(projects)) {
    if (!REPO.test(repo)) problems.push(`projects.${repo} must be named owner/repo`);
    const policy = object(`projects.${repo}.policy`, object(`projects.${repo}`, project)?.policy);
    if (policy === undefined) continue;
    if (!PRESET_NAMES.includes(policy.preset as never)) {
      problems.push(`projects.${repo}.policy.preset must be one of ${PRESET_NAMES.join(", ")}`);
    }
    const overrides = object(`projects.${repo}.policy.overrides`, policy.overrides) ?? {};
    for (const [name, setting] of Object.entries(overrides)) {
      const path = `projects.${repo}.policy.overrides.${name}`;
      if (!POLICY_SETTING_NAMES.includes(name as never)) {
        problems.push(`${path} is not a policy setting`);
      } else if (name === "escalationPaths") {
        if (!Array.isArray(setting) || setting.some((p) => typeof p !== "string")) {
          problems.push(`${path} must be a list of strings`);
        }
      } else if (name === "maxReviewRounds" || name === "openIssueCap") {
        if (!Number.isInteger(setting) || (setting as number) < 0) {
          problems.push(`${path} must be a whole number of 0 or more`);
        }
      } else if (typeof setting !== "boolean") {
        problems.push(`${path} must be true or false`);
      }
    }
  }

  const roles = object("roles", root.roles) ?? {};
  for (const name of ROLE_NAMES) {
    const role = object(`roles.${name}`, roles[name]);
    if (role === undefined) continue;
    string(`roles.${name}.persona`, role.persona);
    if (!Array.isArray(role.skills) || role.skills.some((skill) => typeof skill !== "string")) {
      problems.push(`roles.${name}.skills must be a list of skill names`);
    }
  }
  for (const name of Object.keys(roles)) {
    if (!ROLE_NAMES.includes(name as never)) problems.push(`roles.${name} is not a role`);
  }

  for (const [name, text] of Object.entries(object("instructions", root.instructions) ?? {})) {
    if (!NAME.test(name)) problems.push(`instructions.${name} has an invalid name`);
    string(`instructions.${name}`, text);
  }

  const skills = object("skills", root.skills) ?? {};
  for (const [name, files] of Object.entries(skills)) {
    if (!NAME.test(name)) problems.push(`skills.${name} has an invalid name`);
    for (const [path, text] of Object.entries(object(`skills.${name}`, files) ?? {})) {
      if (!RELATIVE_PATH.test(path))
        problems.push(`skills.${name}.${path} must be a relative path`);
      string(`skills.${name}.${path}`, text);
    }
  }
  for (const name of ROLE_NAMES) {
    const role = roles[name] as RoleConfig | undefined;
    for (const skill of Array.isArray(role?.skills) ? role.skills : []) {
      if (!(skill in skills)) problems.push(`roles.${name}.skills names unknown skill ${skill}`);
    }
  }

  if (problems.length > 0) throw new ConfigValidationError(problems);
  return value as FactoryConfig;
}

export function emptyConfig(): Record<string, never> {
  return {};
}
