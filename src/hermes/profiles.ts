import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "better-sqlite3";
import { ROLE_NAMES, type FactoryConfig, type RoleName } from "../config/document.js";
import { stripAnsi, type FactoryHermes } from "./cli.js";

export interface McpEntry {
  url: string;
  /** The `.env` variable that holds the credential; the header refers to it, so config.yaml holds no secret. */
  tokenEnv: string;
  token: string;
}

/** Toolsets a factory profile never gets. `cronjob` can schedule scripts, which would bring the shell back. */
export const DISABLED_TOOLSETS = ["terminal", "code_execution", "cronjob"];
export const MCP_SERVER_NAME = "hephaestus";

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Keeps the planner, lead, and improver profiles in the factory Hermes root
 * in line with a config version. The persona and skills arrive as a profile
 * distribution; toolsets, the MCP entry, and cron jobs go through the CLI,
 * because `config.yaml` also holds the model settings the owner chose.
 */
export class FactoryProfiles {
  constructor(
    private readonly hermes: FactoryHermes,
    private readonly db: Database,
  ) {}

  get root(): string {
    return this.hermes.root;
  }

  async sync(config: FactoryConfig, version: number, mcp: McpEntry): Promise<void> {
    for (const role of ROLE_NAMES) {
      await this.syncRole(config, role, version, mcp);
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

    await run(["-p", role, "tools", "disable", ...DISABLED_TOOLSETS]);
    await run(["-p", role, "tools", "enable", "kanban"]);
    await run(["-p", role, "config", "set", `mcp_servers.${MCP_SERVER_NAME}.url`, mcp.url]);
    await run([
      "-p",
      role,
      "config",
      "set",
      `mcp_servers.${MCP_SERVER_NAME}.headers.Authorization`,
      `Bearer \${${mcp.tokenEnv}}`,
    ]);
    await run(["-p", role, "config", "set", mcp.tokenEnv, mcp.token]);
    await this.syncCron(role, config.roles[role].cron ?? []);
  }

  /**
   * A profile distribution with the role's persona and skills, in a new
   * directory inside the factory root. The factory root is private to its
   * owner, so the distribution can be readable by `hermes` even when it runs
   * as another user, as in a container.
   */
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

  /** Deletes skill folders Hephaestus installed before that the role no longer lists. */
  private removeDroppedSkills(role: RoleName, profileDir: string, skills: string[]): void {
    const keep = new Set(skills);
    const rows = this.db.prepare("SELECT name FROM hermes_skills WHERE role = ?").all(role) as {
      name: string;
    }[];
    for (const { name } of rows) {
      if (keep.has(name)) continue;
      rmSync(join(profileDir, "skills", name), { recursive: true, force: true });
      this.db.prepare("DELETE FROM hermes_skills WHERE role = ? AND name = ?").run(role, name);
    }
    const insert = this.db.prepare(
      "INSERT INTO hermes_skills (role, name) VALUES (?, ?) ON CONFLICT DO NOTHING",
    );
    for (const name of skills) insert.run(role, name);
  }

  /** Creates, edits, and removes the role's cron jobs by the Hermes job ids recorded at creation. */
  private async syncCron(
    role: RoleName,
    jobs: { name: string; schedule: string; prompt: string }[],
  ): Promise<void> {
    const { run } = this.hermes;
    const recorded = new Map(
      (
        this.db.prepare("SELECT name, job_id FROM hermes_cron_jobs WHERE role = ?").all(role) as {
          name: string;
          job_id: string;
        }[]
      ).map((row) => [row.name, row.job_id]),
    );
    for (const job of jobs) {
      const label = `hephaestus-${job.name}`;
      const id = recorded.get(job.name);
      if (id === undefined) {
        const output = await run([
          "-p",
          role,
          "cron",
          "create",
          job.schedule,
          job.prompt,
          "--name",
          label,
        ]);
        const created = /Created job:\s*(\S+)/.exec(stripAnsi(output))?.[1];
        if (created === undefined) throw new Error(`hermes cron create gave no job id: ${output}`);
        this.db
          .prepare("INSERT INTO hermes_cron_jobs (role, name, job_id) VALUES (?, ?, ?)")
          .run(role, job.name, created);
      } else {
        await run([
          "-p",
          role,
          "cron",
          "edit",
          id,
          "--schedule",
          job.schedule,
          "--prompt",
          job.prompt,
          "--name",
          label,
        ]);
        recorded.delete(job.name);
      }
    }
    for (const [name, id] of recorded) {
      await run(["-p", role, "cron", "remove", id]);
      this.db.prepare("DELETE FROM hermes_cron_jobs WHERE role = ? AND name = ?").run(role, name);
    }
  }
}
