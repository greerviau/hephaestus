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
import { syncFactoryHermes } from "../../src/hermes/setup.js";
import { resolvePaths, type Paths } from "../../src/paths.js";
import type { ServiceManager } from "../../src/service.js";
import { openStore } from "../../src/store.js";
import { sampleConfig } from "../config/fixtures.js";
import { FakeHermes } from "./fake-hermes.js";

let home: string;
let paths: Paths;

class FakeService implements ServiceManager {
  units: string[] = [];
  starts = 0;
  start(): void {
    this.starts += 1;
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
    expect(secrets.get("hermes-mcp-token-planner")).not.toBe(lead);
    expect(readFileSync(join(paths.hermes, "profiles", "lead", ".env"), "utf8")).toContain(
      `HEPHAESTUS_MCP_TOKEN=${lead ?? ""}`,
    );
    expect(service.starts).toBe(1);
    expect(existsSync(paths.gatewayUnit)).toBe(true);
    db.close();
  });
});
