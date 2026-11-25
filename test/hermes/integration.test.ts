import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FactoryBoard } from "../../src/hermes/board.js";
import { hermesRunner } from "../../src/hermes/cli.js";
import { FactoryProfiles } from "../../src/hermes/profiles.js";
import { openStore } from "../../src/store.js";
import { sampleConfig } from "../config/fixtures.js";

/**
 * Runs against a real `hermes` CLI. Set HEPHAESTUS_HERMES_INTEGRATION=1,
 * HEPHAESTUS_HERMES_BIN to the executable, and HEPHAESTUS_HERMES_ROOT to an
 * empty directory to use as the factory root. Run it only where a stray
 * write could not reach anyone's real Hermes home, such as a container, and
 * run hermes as the same user as the test, as Hephaestus does in production.
 */
const bin = process.env.HEPHAESTUS_HERMES_BIN;
const root = process.env.HEPHAESTUS_HERMES_ROOT;
const enabled =
  process.env.HEPHAESTUS_HERMES_INTEGRATION === "1" && bin !== undefined && root !== undefined;

describe.runIf(enabled)("Hermes integration", () => {
  it("syncs the factory profiles and drives the factory board", { timeout: 600_000 }, async () => {
    const factoryRoot = root ?? "";
    const run = hermesRunner(bin ?? "", factoryRoot);
    const db = openStore(":memory:");
    const profiles = new FactoryProfiles({ root: factoryRoot, run }, db);
    const mcp = {
      url: "http://127.0.0.1:7701/mcp",
      tokenEnv: "HEPHAESTUS_MCP_TOKEN",
      token: "test-token",
    };

    const config = sampleConfig();
    config.roles.improver.cron = [
      { name: "nightly", schedule: "30 2 * * *", prompt: "Improve the config." },
    ];
    await profiles.sync(config, 1, mcp);

    for (const role of ["planner", "lead", "improver"]) {
      expect(readFileSync(join(factoryRoot, "profiles", role, "SOUL.md"), "utf8")).toBe(
        config.roles[role as "planner" | "lead" | "improver"].persona,
      );
      const settings = readFileSync(join(factoryRoot, "profiles", role, "config.yaml"), "utf8");
      expect(settings).toContain("http://127.0.0.1:7701/mcp");
      expect(settings).toMatch(
        /disabled_toolsets:\s*\n(\s*- (terminal|code_execution|cronjob)\n){3}/,
      );
      expect(readFileSync(join(factoryRoot, "profiles", role, ".env"), "utf8")).toContain(
        "HEPHAESTUS_MCP_TOKEN=test-token",
      );
    }
    expect(
      existsSync(join(factoryRoot, "profiles", "planner", "skills", "triage", "SKILL.md")),
    ).toBe(true);
    expect(await run(["-p", "improver", "cron", "list"])).toContain("hephaestus-nightly");

    const changed = structuredClone(config);
    changed.roles.lead.persona = "Lead carefully.";
    changed.roles.planner.skills = [];
    changed.roles.improver.cron = [];
    await profiles.sync(changed, 2, mcp);

    expect(readFileSync(join(factoryRoot, "profiles", "lead", "SOUL.md"), "utf8")).toBe(
      "Lead carefully.",
    );
    expect(existsSync(join(factoryRoot, "profiles", "planner", "skills", "triage"))).toBe(false);
    expect(await run(["-p", "improver", "cron", "list"])).not.toContain("hephaestus-nightly");

    const board = new FactoryBoard({ root: factoryRoot, run });
    await board.ensure();
    await board.ensure();
    const id = await board.createCard({
      title: "Integration card",
      body: "Body",
      idempotencyKey: "integration-1",
    });
    expect(
      await board.createCard({ title: "Again", body: "Body", idempotencyKey: "integration-1" }),
    ).toBe(id);
    expect(await board.status(id)).toBe("ready");

    await board.setStage(id, "Implementing", "thread-1");
    expect(await board.status(id)).toBe("blocked");
    await board.setStage(id, "Reviewing", "thread-2");
    expect(await board.status(id)).toBe("blocked");
    await board.setStage(id, "Done");
    expect(await board.status(id)).toBe("done");

    const other = await board.createCard({
      title: "Abandon me",
      body: "Body",
      idempotencyKey: "integration-2",
    });
    await board.setStage(other, "Abandoned");
    expect(await board.status(other)).toBe("archived");
    db.close();
  });
});
