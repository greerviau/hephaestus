import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretsFile } from "../../src/config/secrets.js";
import { ConfigStore } from "../../src/config/store.js";
import { recordShippedInstructions } from "../../src/hermes/profiles.js";
import { applyShippedInstructions, syncFactoryHermes } from "../../src/hermes/setup.js";
import { resolvePaths, type Paths } from "../../src/paths.js";
import type { GatewayControl } from "../../src/legacy-planner.js";
import type { ServiceManager } from "../../src/service.js";
import { openStore } from "../../src/store.js";
import { sampleConfig } from "../config/fixtures.js";
import { FakeHermes } from "./fake-hermes.js";

let home: string;
let paths: Paths;

class FakeService implements ServiceManager, GatewayControl {
  units: string[] = [];
  starts = 0;
  stops = 0;
  constructor(private running = false) {}
  active(): boolean {
    return this.running;
  }
  stopped(): boolean {
    return !this.running;
  }
  stop(): void {
    this.stops += 1;
    this.running = false;
  }
  start(): void {
    this.starts += 1;
    this.running = true;
  }
  install(unit: string): void {
    this.units.push(unit);
    mkdirSync(join(paths.gatewayUnit, ".."), { recursive: true });
    writeFileSync(paths.gatewayUnit, unit);
  }
  remove(): void {
    rmSync(paths.gatewayUnit, { force: true });
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hephaestus-setup-"));
  paths = resolvePaths({ HOME: home });
  mkdirSync(paths.root, { mode: 0o700 });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("syncFactoryHermes", () => {
  it("prepares the factory root, the board, the profiles, and the gateway unit once", async () => {
    const db = openStore(join(paths.root, "state.db"));
    const store = new ConfigStore(db);
    const first = store.createVersion({ document: sampleConfig(), author: "install", message: "" });
    store.approve(first.id);
    const hermes = new FakeHermes();
    const service = new FakeService();
    const options = {
      paths,
      store,
      db,
      secrets: new SecretsFile(paths.secrets),
      hermesPath: "/usr/local/bin/hermes",
      run: hermes.run,
      service,
      mcpUrl: "http://127.0.0.1:7701/mcp",
      gatewayUnitPath: paths.gatewayUnit,
    };

    await syncFactoryHermes(options);
    await syncFactoryHermes(options);

    expect(statSync(paths.hermes).mode & 0o777).toBe(0o700);
    expect(hermes.lines()).toEqual(
      expect.arrayContaining([
        "config set kanban.auto_decompose false",
        "config set kanban.review_dispatch false",
        "kanban boards create --name=Factory -- factory",
        "plugins enable hephaestus",
      ]),
    );
    const plugin = join(paths.hermes, "plugins", "hephaestus");
    expect(readFileSync(join(plugin, "plugin.yaml"), "utf8")).toContain("name: hephaestus");
    expect(readFileSync(join(plugin, "__init__.py"), "utf8")).toContain(
      'register_cli_command(\n        "hephaestus"',
    );
    expect(service.units).toHaveLength(1);
    expect(service.units[0]).toContain(`HERMES_HOME=${paths.hermes}`);
    const secrets = new SecretsFile(paths.secrets);
    const lead = secrets.get("hermes-mcp-token-lead");
    expect(lead).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secrets.get("hermes-mcp-token-communicator")).not.toBe(lead);
    expect(readFileSync(join(paths.hermes, "profiles", "lead", ".env"), "utf8")).toContain(
      `HEPHAESTUS_MCP_TOKEN=${lead ?? ""}`,
    );
    expect(service.starts).toBe(1);
    expect(existsSync(paths.gatewayUnit)).toBe(true);
    db.close();
  });
});

describe("syncFactoryHermes on an install that called the chat agent the planner", () => {
  it("moves its profile and token to the communicator, then syncs", async () => {
    const db = openStore(join(paths.root, "state.db"));
    const store = new ConfigStore(db);
    const first = store.createVersion({ document: sampleConfig(), author: "install", message: "" });
    store.approve(first.id);
    const old = join(paths.hermes, "profiles", "planner");
    mkdirSync(join(old, "memories"), { recursive: true });
    writeFileSync(join(old, "memories", "MEMORY.md"), "kept\n");
    const secrets = new SecretsFile(paths.secrets);
    secrets.set("hermes-mcp-token-planner", "old-token");
    const hermes = new FakeHermes();
    const gateway = new FakeService(true);

    await syncFactoryHermes({
      paths,
      store,
      db,
      secrets,
      hermesPath: "/usr/local/bin/hermes",
      run: hermes.run,
      service: gateway,
      mcpUrl: "http://127.0.0.1:7701/mcp",
      gatewayUnitPath: paths.gatewayUnit,
    });

    expect(existsSync(old)).toBe(false);
    expect(
      readFileSync(join(paths.hermes, "profiles", "communicator", "memories", "MEMORY.md"), "utf8"),
    ).toBe("kept\n");
    expect(secrets.get("hermes-mcp-token-communicator")).toBe("old-token");
    expect(secrets.get("hermes-mcp-token-planner")).toBeUndefined();
    // The running gateway let go of the profile for the move and serves it again after.
    expect(gateway.stops).toBe(1);
    expect(gateway.stopped()).toBe(false);
    expect(hermes.lines()).toContain("profile migrate-identity planner communicator");
    db.close();
  });
});

describe("syncFactoryHermes when the planner profile move is not finished", () => {
  it("syncs the rest and then fails, so the caller knows the threads still need a rekey", async () => {
    const db = openStore(join(paths.root, "state.db"));
    const store = new ConfigStore(db);
    const first = store.createVersion({ document: sampleConfig(), author: "install", message: "" });
    store.approve(first.id);
    mkdirSync(join(paths.hermes, "profiles", "planner"), { recursive: true });
    const hermes = new FakeHermes();
    hermes.answer(
      (args) => args[1] === "migrate-identity",
      () => {
        throw new Error("invalid choice: 'migrate-identity'");
      },
    );
    const gateway = new FakeService(true);

    await expect(
      syncFactoryHermes({
        paths,
        store,
        db,
        secrets: new SecretsFile(paths.secrets),
        hermesPath: "/usr/local/bin/hermes",
        run: hermes.run,
        service: gateway,
        mcpUrl: "http://127.0.0.1:7701/mcp",
        gatewayUnitPath: paths.gatewayUnit,
      }),
    ).rejects.toThrow("not fully moved");
    expect(existsSync(join(paths.hermes, "profiles", "lead"))).toBe(true);
    expect(gateway.stopped()).toBe(false);
    db.close();
  });
});

describe("applyShippedInstructions", () => {
  it("syncs a set-up factory Hermes root once a build ships new role instructions", async () => {
    const db = openStore(":memory:");
    const hermes = join(home, "factory-hermes");
    let syncs = 0;
    const sync = (): Promise<string | undefined> => {
      syncs += 1;
      recordShippedInstructions(db);
      return Promise.resolve(undefined);
    };

    const store = new ConfigStore(db);
    const version = store.createVersion({
      document: sampleConfig(),
      author: "owner",
      message: "m",
    });
    store.approve(version.id);
    const options = { db, store, hermesRoot: hermes, sync };

    // No profiles yet: the first deploy sets the root up, so there is nothing to bring up to date.
    expect(await applyShippedInstructions(options)).toBe(false);
    for (const role of ["communicator", "lead", "improver"]) {
      mkdirSync(join(hermes, "profiles", role), { recursive: true });
    }
    // An approved version the owner has not deployed is not applied.
    expect(await applyShippedInstructions(options)).toBe(false);
    store.markDeployed(version.id);
    expect(await applyShippedInstructions(options)).toBe(true);
    expect(await applyShippedInstructions(options)).toBe(false);
    expect(syncs).toBe(1);
    db.close();
  });

  it("tries again on the next call after a sync fails", async () => {
    const db = openStore(":memory:");
    const store = new ConfigStore(db);
    const version = store.createVersion({
      document: sampleConfig(),
      author: "owner",
      message: "m",
    });
    store.approve(version.id);
    store.markDeployed(version.id);
    const hermes = join(home, "factory-hermes");
    for (const role of ["communicator", "lead", "improver"]) {
      mkdirSync(join(hermes, "profiles", role), { recursive: true });
    }
    let syncs = 0;
    const sync = (): Promise<string | undefined> => {
      syncs += 1;
      if (syncs === 1) return Promise.resolve("hermes exited with 1");
      recordShippedInstructions(db);
      return Promise.resolve(undefined);
    };
    const options = { db, store, hermesRoot: hermes, sync };
    await applyShippedInstructions(options);
    await applyShippedInstructions(options);
    await applyShippedInstructions(options);
    expect(syncs).toBe(2);
    db.close();
  });
});
