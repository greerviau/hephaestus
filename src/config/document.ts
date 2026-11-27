import { renameLegacyRole } from "../legacy-planner.js";
import { POLICY_SETTING_NAMES, PRESET_NAMES, type Policy } from "./policy.js";

export const ROLE_NAMES = ["communicator", "lead", "improver"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export interface RoleConfig {
  /** The owner's instructions for the role, which its Hermes profile gets after the shipped ones. */
  persona: string;
  /** Names of skills in `FactoryConfig.skills` that the role loads. */
  skills: string[];
  /** Scheduled jobs for the role's Hermes profile. */
  cron?: CronJob[];
}

export interface CronJob {
  /** Unique within the role; Hephaestus names the Hermes job `hephaestus-<name>`. */
  name: string;
  /** A Hermes schedule: a cron expression, or forms such as `every 2h`. */
  schedule: string;
  prompt: string;
  /** False keeps the job in the config but out of Hermes. Absent means on. */
  enabled?: boolean;
}

export interface ProjectConfig {
  policy: Policy;
  /**
   * Names of skills in `FactoryConfig.skills` that factory threads for this project load, besides
   * `FactorySettings.threadSkills`. Absent means none.
   */
  skills?: string[];
}

export interface ModelChoice {
  model: string;
  /** Provider options such as `effort`, by T3 option id. */
  options?: Record<string, string | boolean>;
}

/** How Hephaestus runs factory threads and the setup threads on each worker. */
export interface FactorySettings {
  /** Names of skills in `FactoryConfig.skills` that factory threads load. */
  threadSkills: string[];
  /** The model each factory instance runs. */
  models: { claude: ModelChoice; codex: ModelChoice };
  /** The owner is told about an admitted task the lead has neither queued nor deferred after this many minutes; 0 never tells. */
  triageAlertMinutes: number;
  /** The owner's own provider instance and model that run deploy and sign-in threads on a worker. */
  setup: ModelChoice & { instanceId: string };
  limits: {
    /**
     * Tasks in progress per worker, from Implementing through Validating, or with the lead.
     * A task waiting on the owner does not count.
     */
    tasksPerWorker: number;
    /** Running factory threads per worker. */
    threadsPerWorker: number;
    /** Running factory threads across all workers. */
    threads: number;
    /** Factory threads started per UTC day. */
    startsPerDay: number;
  };
}

export const DEFAULT_FACTORY: FactorySettings = {
  threadSkills: [],
  triageAlertMinutes: 30,
  models: { claude: { model: "claude-sonnet-5-5" }, codex: { model: "gpt-6.2-sol" } },
  setup: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
  limits: { tasksPerWorker: 2, threadsPerWorker: 2, threads: 4, startsPerDay: 40 },
};

/** The whole factory config. A config version is one snapshot of it. */
export interface FactoryConfig {
  factory: FactorySettings;
  /** Keyed by GitHub `owner/repo`. */
  projects: Record<string, ProjectConfig>;
  roles: Record<RoleName, RoleConfig>;
  /** Instruction files for factory threads, keyed by name. */
  instructions: Record<string, string>;
  /** Skills keyed by name, each a map from relative file path to text content. */
  skills: Record<string, Record<string, string>>;
}

/**
 * A project's config by repo. GitHub repo names are not case-sensitive, so a
 * task or issue recorded under another casing still finds its project.
 */
export function projectFor(
  projects: Record<string, ProjectConfig> | undefined,
  repo: string,
): ProjectConfig | undefined {
  const key = projectKey(projects, repo);
  return key === undefined ? undefined : projects?.[key];
}

/** The config's own spelling of a project's repo, found without regard to case. */
export function projectKey(
  projects: Record<string, ProjectConfig> | undefined,
  repo: string,
): string | undefined {
  if (projects === undefined) return undefined;
  if (projects[repo] !== undefined) return repo;
  return Object.keys(projects).find((name) => name.toLowerCase() === repo.toLowerCase());
}

/**
 * The folder a worker keeps a project's factory clone and skills under: the repo as
 * `owner__repo`, in lower case, since GitHub repo names are not case-sensitive.
 */
export function projectFolder(repo: string): string {
  return repo.toLowerCase().replace("/", "__");
}

export class ConfigValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid config: ${problems.join("; ")}`);
  }
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** The largest config, in UTF-8 bytes of JSON, that a version may hold; the JSON editor on Config can save any config up to this size. */
export const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

// eslint-disable-next-line no-control-regex
const UNSAFE_SEGMENT = /[\\\u0000-\u001f\u007f]/;

/** A path inside a skill folder: `/`-separated, with no empty, `.`, or `..` segments, backslashes, or control characters. */
export function isSafeRelativePath(path: string): boolean {
  return path
    .split("/")
    .every(
      (segment) =>
        segment !== "" && segment !== "." && segment !== ".." && !UNSAFE_SEGMENT.test(segment),
    );
}

/**
 * Each path in `paths` that lies inside another path of the list, with that
 * other path. A skill is written to disk as a folder, where one name cannot
 * be both a file and a folder.
 */
export function pathsInsideFiles(paths: readonly string[]): [path: string, file: string][] {
  const all = new Set(paths);
  const found: [string, string][] = [];
  for (const path of paths) {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const above = segments.slice(0, depth).join("/");
      if (all.has(above)) found.push([path, above]);
    }
  }
  return found;
}

/** What the config says about a skill file that lies inside another file. */
export function insideFileProblem(skill: string, path: string, file: string): string {
  return `skills.${skill}.${JSON.stringify(path)} is inside ${JSON.stringify(file)}, which is a file, not a folder`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fills in what a config may leave out: the factory settings' defaults, and
 * for each project the `standard` preset and an empty overrides map.
 */
export function normalizeConfig(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const renamed = renameLegacyRole(value);
  // Only what is missing gets its default; a value of the wrong type stays for validation to refuse.
  if (renamed.factory !== undefined && !isRecord(renamed.factory)) return value;
  const factory = renamed.factory ?? {};
  if (factory.limits !== undefined && !isRecord(factory.limits)) return value;
  const limits = factory.limits ?? {};
  value = {
    ...renamed,
    factory: {
      ...structuredClone(DEFAULT_FACTORY),
      ...factory,
      limits: { ...DEFAULT_FACTORY.limits, ...limits },
    },
  };
  if (!isRecord(value) || !isRecord(value.projects)) return value;
  const projects: Record<string, unknown> = {};
  for (const [repo, project] of Object.entries(value.projects)) {
    if (!isRecord(project)) {
      projects[repo] = project;
      continue;
    }
    const policy = isRecord(project.policy) ? project.policy : {};
    projects[repo] = { ...project, policy: { preset: "standard", overrides: {}, ...policy } };
  }
  return { ...value, projects };
}

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
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_CONFIG_BYTES) {
    throw new ConfigValidationError([
      `the config is too large: at most ${String(MAX_CONFIG_BYTES / 1024 / 1024)} MB as JSON`,
    ]);
  }
  for (const key of Object.keys(root)) {
    if (!["factory", "projects", "roles", "instructions", "skills"].includes(key)) {
      problems.push(`config.${key} is not a config section`);
    }
  }

  const factory = object("factory", root.factory);
  if (factory !== undefined) {
    const model = (path: string, v: unknown): Record<string, unknown> | undefined => {
      const choice = object(path, v);
      if (choice === undefined) return undefined;
      if (typeof choice.model !== "string" || choice.model === "") {
        problems.push(`${path}.model must be a non-empty string`);
      }
      if (choice.options !== undefined) {
        const options = object(`${path}.options`, choice.options) ?? {};
        for (const [id, option] of Object.entries(options)) {
          if (typeof option !== "string" && typeof option !== "boolean") {
            problems.push(`${path}.options.${id} must be a string or true or false`);
          }
        }
      }
      return choice;
    };
    const models = object("factory.models", factory.models);
    if (models !== undefined) {
      model("factory.models.claude", models.claude);
      model("factory.models.codex", models.codex);
    }
    const setup = model("factory.setup", factory.setup);
    if (setup !== undefined && (typeof setup.instanceId !== "string" || setup.instanceId === "")) {
      problems.push("factory.setup.instanceId must be a non-empty string");
    }
    if (
      !Number.isInteger(factory.triageAlertMinutes) ||
      (factory.triageAlertMinutes as number) < 0
    ) {
      problems.push("factory.triageAlertMinutes must be a whole number of 0 or more");
    }
    const limits = object("factory.limits", factory.limits) ?? {};
    for (const name of ["tasksPerWorker", "threadsPerWorker", "threads", "startsPerDay"]) {
      if (!Number.isInteger(limits[name]) || (limits[name] as number) < 0) {
        problems.push(`factory.limits.${name} must be a whole number of 0 or more`);
      }
    }
    if (
      !Array.isArray(factory.threadSkills) ||
      factory.threadSkills.some((skill) => typeof skill !== "string")
    ) {
      problems.push("factory.threadSkills must be a list of skill names");
    }
  }

  const projects = object("projects", root.projects) ?? {};
  for (const [repo, project] of Object.entries(projects)) {
    if (!REPO.test(repo)) problems.push(`projects.${repo} must be named owner/repo`);
    const entry = object(`projects.${repo}`, project);
    if (
      entry?.skills !== undefined &&
      (!Array.isArray(entry.skills) || entry.skills.some((skill) => typeof skill !== "string"))
    ) {
      problems.push(`projects.${repo}.skills must be a list of skill names`);
    }
    const policy = object(`projects.${repo}.policy`, entry?.policy);
    if (policy === undefined) continue;
    if (!PRESET_NAMES.includes(policy.preset as never)) {
      problems.push(`projects.${repo}.policy.preset must be one of ${PRESET_NAMES.join(", ")}`);
    }
    const overrides = object(`projects.${repo}.policy.overrides`, policy.overrides) ?? {};
    for (const [name, setting] of Object.entries(overrides)) {
      const path = `projects.${repo}.policy.overrides.${name}`;
      if (!POLICY_SETTING_NAMES.includes(name as never)) {
        problems.push(`${path} is not a policy setting`);
      } else if (name === "escalationPaths" || name === "requiredChecks") {
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
    if (role.cron !== undefined) {
      const jobs: unknown[] = Array.isArray(role.cron) ? role.cron : [];
      if (!Array.isArray(role.cron)) problems.push(`roles.${name}.cron must be a list`);
      const seen = new Set<string>();
      for (const [index, job] of jobs.entries()) {
        const path = `roles.${name}.cron[${String(index)}]`;
        const entry = object(path, job);
        if (entry === undefined) continue;
        if (typeof entry.name !== "string" || !NAME.test(entry.name)) {
          problems.push(`${path}.name must be a simple name`);
        } else if (seen.has(entry.name)) {
          problems.push(`${path}.name repeats ${entry.name}`);
        } else {
          seen.add(entry.name);
        }
        for (const field of ["schedule", "prompt"] as const) {
          if (typeof entry[field] !== "string" || entry[field] === "") {
            problems.push(`${path}.${field} must be a non-empty string`);
          }
        }
        if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
          problems.push(`${path}.enabled must be true or false`);
        }
      }
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
    const contents = object(`skills.${name}`, files) ?? {};
    if (!Object.hasOwn(contents, "SKILL.md")) problems.push(`skills.${name} has no SKILL.md`);
    for (const [path, text] of Object.entries(contents)) {
      if (!isSafeRelativePath(path)) {
        problems.push(`skills.${name}.${JSON.stringify(path)} must be a relative path`);
      }
      string(`skills.${name}.${path}`, text);
    }
    for (const [path, file] of pathsInsideFiles(Object.keys(contents))) {
      problems.push(insideFileProblem(name, path, file));
    }
  }
  const threadSkills = (factory as { threadSkills?: unknown } | undefined)?.threadSkills;
  for (const skill of Array.isArray(threadSkills) ? (threadSkills as unknown[]) : []) {
    if (typeof skill === "string" && !Object.hasOwn(skills, skill)) {
      problems.push(`factory.threadSkills names unknown skill ${skill}`);
    }
  }
  for (const [repo, project] of Object.entries(projects)) {
    const loaded = isRecord(project) ? project.skills : undefined;
    for (const skill of Array.isArray(loaded) ? (loaded as unknown[]) : []) {
      if (typeof skill === "string" && !Object.hasOwn(skills, skill)) {
        problems.push(`projects.${repo}.skills names unknown skill ${skill}`);
      }
    }
  }
  for (const name of ROLE_NAMES) {
    const role = roles[name] as RoleConfig | undefined;
    for (const skill of Array.isArray(role?.skills) ? role.skills : []) {
      if (!Object.hasOwn(skills, skill)) {
        problems.push(`roles.${name}.skills names unknown skill ${skill}`);
      }
    }
  }

  if (problems.length > 0) throw new ConfigValidationError(problems);
  return value as FactoryConfig;
}

export function emptyConfig(): Record<string, never> {
  return {};
}
