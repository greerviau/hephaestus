import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  it("turns off terminal, code execution and cron tools on every platform, and adds the MCP entry", async () => {
    await profiles.sync(sampleConfig(), 1, mcp);

    const lead = hermes.lines().filter((line) => line.startsWith("-p lead "));
    expect(lead).toEqual(
      expect.arrayContaining([
        "-p lead tools disable terminal code_execution cronjob",
        "-p lead tools enable kanban",
        "-p lead config set agent.disabled_toolsets [terminal, code_execution, cronjob]",
        "-p lead config set mcp_servers.hephaestus.url http://127.0.0.1:7701/mcp",
        "-p lead config set mcp_servers.hephaestus.headers.Authorization Bearer ${HEPHAESTUS_MCP_TOKEN}",
      ]),
    );
  });

  it("writes the MCP token to the profile's .env without passing it as an argument", async () => {
    mkdirSync(join(root, "profiles", "lead"), { recursive: true });
    writeFileSync(join(root, "profiles", "lead", ".env"), "OTHER=1\nHEPHAESTUS_MCP_TOKEN=old\n");

    await profiles.sync(sampleConfig(), 1, mcp);

    expect(hermes.calls.some((call) => call.args.some((arg) => arg.includes("secret-token")))).toBe(
      false,
    );
    const env = join(root, "profiles", "lead", ".env");
    expect(readFileSync(env, "utf8")).toBe("OTHER=1\nHEPHAESTUS_MCP_TOKEN=secret-token\n");
    expect(statSync(env).mode & 0o777).toBe(0o600);
  });

  it("passes config text after -- and option values with =, so a leading dash stays text", async () => {
    const config = sampleConfig();
    config.roles.improver.cron = [
      { name: "nightly", schedule: "30 2 * * *", prompt: "--check everything" },
    ];

    await profiles.sync(config, 1, mcp);

    expect(
      hermes.calls.map((call) => call.args).filter((args) => args.includes("cron")),
    ).toContainEqual([
      "-p",
      "improver",
      "cron",
      "create",
      "--name=hephaestus-nightly",
      "--",
      "30 2 * * *",
      "--check everything",
    ]);
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

    expect(
      hermes.lines().filter((line) => line.includes(" cron ") && !line.endsWith("cron list")),
    ).toEqual([
      "-p improver cron create --name=hephaestus-nightly -- 30 2 * * * Improve.",
      "-p improver cron edit --schedule=0 3 * * * --prompt=Improve more. --name=hephaestus-nightly -- job-1",
      "-p improver cron remove -- job-1",
    ]);
  });

  it("adopts a job Hermes already has under the managed name instead of creating another", async () => {
    hermes.answer(
      (args) => args.includes("cron") && args.includes("list"),
      "  lost123 [active]\n    Name:      hephaestus-nightly\n    Schedule:  30 2 * * *\n",
    );
    const config = sampleConfig();
    config.roles.improver.cron = [{ name: "nightly", schedule: "30 2 * * *", prompt: "Improve." }];

    await profiles.sync(config, 1, mcp);

    const cron = hermes
      .lines()
      .filter((line) => line.includes("improver cron ") && !line.endsWith("cron list"));
    expect(cron).toEqual([
      "-p improver cron edit --schedule=30 2 * * * --prompt=Improve. --name=hephaestus-nightly -- lost123",
    ]);
  });

  it("treats removing a job Hermes no longer has as done", async () => {
    const config = sampleConfig();
    config.roles.improver.cron = [{ name: "nightly", schedule: "30 2 * * *", prompt: "Improve." }];
    await profiles.sync(config, 1, mcp);
    hermes.answer(
      (args) => args.includes("remove"),
      () => {
        throw new Error("hermes -p improver cron failed: Job not found: job-1");
      },
    );
    config.roles.improver.cron = [];

    await expect(profiles.sync(config, 2, mcp)).resolves.toBeUndefined();
    await expect(profiles.sync(config, 3, mcp)).resolves.toBeUndefined();
  });

  it("removes a skill directory that the config no longer lists", async () => {
    await profiles.sync(sampleConfig(), 1, mcp);
    mkdirSync(join(root, "profiles", "planner", "skills", "triage"), { recursive: true });
    const config = sampleConfig();
    config.roles.planner.skills = [];

    await profiles.sync(config, 2, mcp);

    expect(existsSync(join(root, "profiles", "planner", "skills", "triage"))).toBe(false);
  });

  it("does not claim a skill whose install failed", async () => {
    const failing = new FakeHermes();
    failing.answer(
      (args) => args[1] === "install",
      () => {
        throw new Error("install failed");
      },
    );
    const broken = new FactoryProfiles({ root, run: failing.run }, db);
    await expect(broken.sync(sampleConfig(), 1, mcp)).rejects.toThrow(/install failed/);
    mkdirSync(join(root, "profiles", "planner", "skills", "triage"), { recursive: true });
    const config = sampleConfig();
    config.roles.planner.skills = [];

    await profiles.sync(config, 2, mcp);

    expect(existsSync(join(root, "profiles", "planner", "skills", "triage"))).toBe(true);
  });

  it("refuses to delete a skill through a symlink that leaves the factory root", async () => {
    await profiles.sync(sampleConfig(), 1, mcp);
    const outside = mkdtempSync(join(tmpdir(), "hephaestus-outside-"));
    try {
      mkdirSync(join(outside, "triage"));
      rmSync(join(root, "profiles", "planner", "skills"), { recursive: true, force: true });
      symlinkSync(outside, join(root, "profiles", "planner", "skills"));
      const config = sampleConfig();
      config.roles.planner.skills = [];

      await expect(profiles.sync(config, 2, mcp)).rejects.toThrow(
        /outside the factory root|symlink/,
      );
      expect(existsSync(join(outside, "triage"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("runs every command against the factory root only", () => {
    expect(profiles.root).toBe(root);
  });

  it("gives a profile without a model the root's model and provider, and leaves a chosen one", async () => {
    writeFileSync(
      join(root, "config.yaml"),
      "model:\n  default: claude-sonnet-5\n  provider: anthropic\n",
    );
    mkdirSync(join(root, "profiles", "lead"), { recursive: true });
    writeFileSync(
      join(root, "profiles", "lead", "config.yaml"),
      "model:\n  default: gpt-6.2-sol\n",
    );
    await profiles.sync(sampleConfig(), 1, mcp);
    const sets = hermes.calls
      .map((call) => call.args.join(" "))
      .filter((args) => args.includes("config set model."));
    expect(sets).toEqual([
      "-p planner config set model.default claude-sonnet-5",
      "-p planner config set model.provider anthropic",
      "-p improver config set model.default claude-sonnet-5",
      "-p improver config set model.provider anthropic",
    ]);
  });
});
