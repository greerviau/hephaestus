import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { Database } from "better-sqlite3";
import { ROLE_NAMES, type CronJob, type FactoryConfig, type RoleName } from "../config/document.js";
import { stripAnsi, type FactoryHermes } from "./cli.js";
import { hermesModel, hermesModelBlock } from "./model.js";

export interface McpEntry {
  url: string;
  /** The `.env` variable that holds the credential; the header refers to it, so config.yaml holds no secret. */
  tokenEnv: string;
  token: string;
}

/** Toolsets a factory profile never gets. `cronjob` can schedule scripts, which would bring the shell back. */
export const DISABLED_TOOLSETS = ["terminal", "code_execution", "cronjob"];
export const MCP_SERVER_NAME = "hephaestus";
const CRON_PREFIX = "hephaestus-";

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** Parses `hermes cron list` into job names and ids. */
function listedJobs(output: string): Map<string, string> {
  const jobs = new Map<string, string>();
  let id: string | undefined;
  for (const line of stripAnsi(output).split("\n")) {
    const header = /^\s{2}(\S+)\s+\[/.exec(line);
    if (header !== null) {
      id = header[1];
      continue;
    }
    const name = /^\s+Name:\s+(\S+)/.exec(line)?.[1];
    if (name !== undefined && id !== undefined) jobs.set(name, id);
  }
  return jobs;
}

/**
 * Keeps the planner, lead, and improver profiles in the factory Hermes root
 * in line with a config version. The persona and skills arrive as a profile
 * distribution; toolsets, the MCP entry, and cron jobs go through the CLI,
 * because `config.yaml` also holds the model settings the owner chose. The
 * MCP token is written straight to the profile's `.env`, so it never appears
 * in a command line.
 */
export class FactoryProfiles {
  constructor(
    private readonly hermes: FactoryHermes,
    private readonly db: Database,
  ) {}

  get root(): string {
    return this.hermes.root;
  }

  /**
   * A profile has its own config.yaml, and a role without a model cannot run.
   * A profile that names no model gets the root's model and provider, for a
   * root the owner set with `hermes model` on the host; one already configured,
   * for example from the Model page, is left alone.
   */
  private async inheritModel(role: RoleName, profileDir: string): Promise<void> {
    const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");
    if (hermesModel(read(join(profileDir, "config.yaml"))) !== undefined) return;
    const root = hermesModelBlock(read(join(this.hermes.root, "config.yaml")));
    if ((root.default ?? root.model) === undefined) return;
    // A named custom provider also needs its custom_providers entry, and a key lives in the root's
    // .env, which a profile does not read; copying either would mean copying a secret. The Model
    // page sets such a model on every profile itself.
    if (root.provider?.startsWith("custom:") === true || root.api_key !== undefined) return;
    // Every key, so a custom endpoint's base_url, api_key, and api_mode come along.
    for (const [key, value] of Object.entries(root)) {
      await this.hermes.run(["-p", role, "config", "set", `model.${key}`, value]);
    }
  }

  /** `mcp` gives each role its own entry, so the MCP server knows which profile calls it. */
  async sync(
    config: FactoryConfig,
    version: number,
    mcp: McpEntry | ((role: RoleName) => McpEntry),
  ): Promise<void> {
    for (const role of ROLE_NAMES) {
      await this.syncRole(config, role, version, typeof mcp === "function" ? mcp(role) : mcp);
    }
  }

  private async syncRole(
    config: FactoryConfig,
    role: RoleName,
    version: number,
    mcp: McpEntry,
  ): Promise<void> {
    const { run } = this.hermes;
    // `profile install` creates the profile when it is missing. `profile create`
    // would first add Hermes's default persona and skills.
    const profileDir = join(this.hermes.root, "profiles", role);
    const skills = config.roles[role].skills;
    this.removeDroppedSkills(role, profileDir, skills);
    const distribution = this.writeDistribution(config, role, version);
    try {
      await run(["profile", "install", distribution, "--name", role, "--force", "-y"]);
    } finally {
      rmSync(distribution, { recursive: true, force: true });
    }
    this.recordSkills(role, skills);

    await run(["-p", role, "tools", "disable", ...DISABLED_TOOLSETS]);
    await run(["-p", role, "tools", "enable", "kanban"]);
    // `tools disable` covers only the cli platform; this covers every platform.
    await run([
      "-p",
      role,
      "config",
      "set",
      "agent.disabled_toolsets",
      `[${DISABLED_TOOLSETS.join(", ")}]`,
    ]);
    await run(["-p", role, "config", "set", `mcp_servers.${MCP_SERVER_NAME}.url`, mcp.url]);
    await run([
      "-p",
      role,
      "config",
      "set",
      `mcp_servers.${MCP_SERVER_NAME}.headers.Authorization`,
      `Bearer \${${mcp.tokenEnv}}`,
    ]);
    this.writeEnv(profileDir, mcp.tokenEnv, mcp.token);
    await this.inheritModel(role, profileDir);
    await this.syncCron(role, config.roles[role].cron ?? []);
  }

  /** A profile distribution with the role's persona and skills, in a new directory inside the factory root. */
  private writeDistribution(config: FactoryConfig, role: RoleName, version: number): string {
    const dir = mkdtempSync(join(this.hermes.root, `.hephaestus-${role}-`));
    chmodSync(dir, 0o755);
    const skills = config.roles[role].skills;
    const owned = ["SOUL.md", ...skills.map((skill) => `skills/${skill}/`)];
    writeFileSync(
      join(dir, "distribution.yaml"),
      [
        `name: ${role}`,
        `version: 0.0.${String(version)}`,
        `description: ${yamlString(`Hephaestus ${role}, config version ${String(version)}`)}`,
        "distribution_owned:",
        ...owned.map((path) => `  - ${path}`),
        "",
      ].join("\n"),
      { mode: 0o644 },
    );
    writeFileSync(join(dir, "SOUL.md"), config.roles[role].persona, { mode: 0o644 });
    for (const skill of skills) {
      for (const [path, text] of Object.entries(config.skills[skill] ?? {})) {
        const target = join(dir, "skills", skill, path);
        mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
        writeFileSync(target, text, { mode: 0o644 });
      }
    }
    return dir;
  }

  /** Sets one variable in the profile's `.env`, keeping the other lines, with mode 600. */
  private writeEnv(profileDir: string, key: string, value: string): void {
    const path = join(profileDir, ".env");
    this.assertInsideRoot(path);
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    const lines = existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => line !== "" && !line.startsWith(`${key}=`))
      : [];
    lines.push(`${key}=${value}`);
    const temporary = `${path}.hephaestus-tmp`;
    writeFileSync(temporary, `${lines.join("\n")}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }

  /** Deletes skill folders Hephaestus installed before that the role no longer lists. */
  private removeDroppedSkills(role: RoleName, profileDir: string, skills: string[]): void {
    const keep = new Set(skills);
    const rows = this.db.prepare("SELECT name FROM hermes_skills WHERE role = ?").all(role) as {
      name: string;
    }[];
    for (const { name } of rows) {
      if (keep.has(name)) continue;
      const target = join(profileDir, "skills", name);
      this.assertInsideRoot(target);
      rmSync(target, { recursive: true, force: true });
      this.db.prepare("DELETE FROM hermes_skills WHERE role = ? AND name = ?").run(role, name);
    }
  }

  /** Records the skills a successful install put in place, so a later sync may prune them. */
  private recordSkills(role: RoleName, skills: string[]): void {
    const insert = this.db.prepare(
      "INSERT INTO hermes_skills (role, name) VALUES (?, ?) ON CONFLICT DO NOTHING",
    );
    for (const name of skills) insert.run(role, name);
  }

  /**
   * Refuses a path that a symlink could carry out of the factory root: every
   * existing component below the root must be a real directory or file.
   */
  private assertInsideRoot(path: string): void {
    const root = realpathSync(this.hermes.root);
    const rel = relative(this.hermes.root, path);
    if (rel.startsWith("..") || rel === "") {
      throw new Error(`${path} is outside the factory root.`);
    }
    let current = this.hermes.root;
    for (const part of rel.split(sep)) {
      current = join(current, part);
      if (!existsSync(current)) return;
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`${current} is a symlink; Hephaestus will not write or delete through it.`);
      }
      if (!realpathSync(current).startsWith(root + sep)) {
        throw new Error(`${current} is outside the factory root.`);
      }
    }
  }

  /**
   * Creates, edits, and removes the role's cron jobs. Jobs are matched by the
   * id Hephaestus recorded, else by their managed name in `cron list`, so a
   * job whose creation reply was lost is adopted instead of duplicated.
   */
  private async syncCron(role: RoleName, jobs: CronJob[]): Promise<void> {
    const { run } = this.hermes;
    const recorded = new Map(
      (
        this.db.prepare("SELECT name, job_id FROM hermes_cron_jobs WHERE role = ?").all(role) as {
          name: string;
          job_id: string;
        }[]
      ).map((row) => [row.name, row.job_id]),
    );
    const listed = listedJobs(await run(["-p", role, "cron", "list"]));
    const record = this.db.prepare(
      `INSERT INTO hermes_cron_jobs (role, name, job_id) VALUES (?, ?, ?)
       ON CONFLICT (role, name) DO UPDATE SET job_id = excluded.job_id`,
    );
    for (const job of jobs) {
      const label = `${CRON_PREFIX}${job.name}`;
      const id = recorded.get(job.name) ?? listed.get(label);
      if (id === undefined) {
        const output = await run([
          "-p",
          role,
          "cron",
          "create",
          `--name=${label}`,
          "--",
          job.schedule,
          job.prompt,
        ]);
        const created = /Created job:\s*(\S+)/.exec(stripAnsi(output))?.[1];
        if (created === undefined) throw new Error(`hermes cron create gave no job id: ${output}`);
        record.run(role, job.name, created);
      } else {
        await run([
          "-p",
          role,
          "cron",
          "edit",
          `--schedule=${job.schedule}`,
          `--prompt=${job.prompt}`,
          `--name=${label}`,
          "--",
          id,
        ]);
        record.run(role, job.name, id);
      }
      recorded.delete(job.name);
      listed.delete(label);
    }
    // Jobs Hephaestus recorded, or that carry its name prefix, and that the config no longer lists.
    const stale = new Map(recorded);
    for (const [label, id] of listed) {
      if (label.startsWith(CRON_PREFIX)) stale.set(label.slice(CRON_PREFIX.length), id);
    }
    for (const [name, id] of stale) {
      try {
        await run(["-p", role, "cron", "remove", "--", id]);
      } catch (error) {
        if (!/not found/i.test(String(error))) throw error;
      }
      this.db.prepare("DELETE FROM hermes_cron_jobs WHERE role = ? AND name = ?").run(role, name);
    }
  }
}
