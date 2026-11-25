import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactoryProfiles } from "../../src/hermes/profiles.js";
import { openStore } from "../../src/store.js";
import { sampleConfig } from "../config/fixtures.js";
import { FakeHermes } from "./fake-hermes.js";

let root: string;
let db: Database;
let hermes: FakeHermes;
let profiles: FactoryProfiles;
let installed: { dir: string; soul: string; manifest: string; skills: string[]; mode: number }[];

const mcp = {
  url: "http://127.0.0.1:7701/mcp",
  tokenEnv: "HEPHAESTUS_MCP_TOKEN",
  token: "secret-token",
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hephaestus-hermes-"));
  db = openStore(":memory:");
  hermes = new FakeHermes();
  installed = [];
  hermes.answer(
    (args) => args[0] === "profile" && args[1] === "create",
    (args) => {
      mkdirSync(join(root, "profiles", args[2] ?? ""), { recursive: true });
      return "";
    },
  );
  hermes.answer(
    (args) => args[0] === "profile" && args[1] === "install",
    (args) => {
      const dir = args[2] ?? "";
      installed.push({
        dir,
        soul: readFileSync(join(dir, "SOUL.md"), "utf8"),
        manifest: readFileSync(join(dir, "distribution.yaml"), "utf8"),
        skills: existsSync(join(dir, "skills")) ? [...new Set(readSkills(dir))] : [],
        mode: statSync(dir).mode & 0o777,
      });
      return "";
    },
  );
  let next = 0;
  hermes.answer(
    (args) => args.includes("cron") && args.includes("create"),
    () => {
      next += 1;
      return `\u001b[32mCreated job: job-${String(next)}\u001b[0m\n`;
    },
  );
  profiles = new FactoryProfiles({ root, run: hermes.run }, db);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  db.close();
});

function readSkills(dir: string): string[] {
  return readFileSync(join(dir, "distribution.yaml"), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("  - skills/"))
    .map((line) => line.slice("  - skills/".length).replace(/\/$/, ""));
}

describe("FactoryProfiles.sync", () => {
  it("installs each role's persona and skills as a distribution, without profile create", async () => {
    await profiles.sync(sampleConfig(), 3, mcp);

    expect(hermes.lines().some((line) => line.startsWith("profile create"))).toBe(false);
    const planner = installed.find((entry) => entry.soul === "Plan the work.");
    expect(planner?.manifest).toContain("name: planner");
    expect(planner?.manifest).toContain("version: 0.0.3");
    expect(planner?.skills).toEqual(["triage"]);
    expect(planner?.dir.startsWith(root)).toBe(true);
    expect(planner?.mode).toBe(0o755);
    expect(hermes.lines()).toContain(
      `profile install ${planner?.dir ?? ""} --name planner --force -y`,
    );
    for (const entry of installed) expect(existsSync(entry.dir)).toBe(false);
  });

  it("disables terminal, code execution and cron tools, enables kanban, and adds the Hephaestus MCP entry", async () => {
    await profiles.sync(sampleConfig(), 1, mcp);

    const lead = hermes.lines().filter((line) => line.startsWith("-p lead "));
    expect(lead).toEqual(
      expect.arrayContaining([
        "-p lead tools disable terminal code_execution cronjob",
        "-p lead tools enable kanban",
        "-p lead config set mcp_servers.hephaestus.url http://127.0.0.1:7701/mcp",
        "-p lead config set mcp_servers.hephaestus.headers.Authorization Bearer ${HEPHAESTUS_MCP_TOKEN}",
        "-p lead config set HEPHAESTUS_MCP_TOKEN secret-token",
      ]),
    );
  });

  it("creates, edits and removes cron jobs by the ids it recorded", async () => {
    const config = sampleConfig();
    config.roles.improver.cron = [{ name: "nightly", schedule: "30 2 * * *", prompt: "Improve." }];
    await profiles.sync(config, 1, mcp);

    config.roles.improver.cron = [
      { name: "nightly", schedule: "0 3 * * *", prompt: "Improve more." },
    ];
    await profiles.sync(config, 2, mcp);

    config.roles.improver.cron = [];
    await profiles.sync(config, 3, mcp);

    expect(hermes.lines().filter((line) => line.includes(" cron "))).toEqual([
      "-p improver cron create 30 2 * * * Improve. --name hephaestus-nightly",
      "-p improver cron edit job-1 --schedule 0 3 * * * --prompt Improve more. --name hephaestus-nightly",
      "-p improver cron remove job-1",
    ]);
  });

  it("removes a skill directory that the config no longer lists", async () => {
    await profiles.sync(sampleConfig(), 1, mcp);
    mkdirSync(join(root, "profiles", "planner", "skills", "triage"), { recursive: true });
    const config = sampleConfig();
    config.roles.planner.skills = [];

    await profiles.sync(config, 2, mcp);

    expect(existsSync(join(root, "profiles", "planner", "skills", "triage"))).toBe(false);
  });

  it("runs every command against the factory root only", () => {
    expect(profiles.root).toBe(root);
  });
});
