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
import { readPasswordHash, verifyPassword } from "../src/auth.js";
import { AlreadyInstalledError, NotInstalledError, install, uninstall } from "../src/install.js";
import { resolvePaths, type Paths } from "../src/paths.js";
import type { ServiceManager } from "../src/service.js";
import { openStore } from "../src/store.js";

class FakeService implements ServiceManager {
  calls: string[] = [];
  unit: string | undefined;
  install(unit: string): void {
    this.unit = unit;
    this.calls.push("install");
  }
  remove(): void {
    this.unit = undefined;
    this.calls.push("remove");
  }
}

let home: string;
let paths: Paths;
let service: FakeService;

const options = () => ({
  paths,
  service,
  password: "correct horse battery",
  port: 7700,
  nodePath: "/usr/bin/node",
  cliPath: "/opt/hephaestus/dist/cli.js",
});

function write(relativePath: string, content: string): void {
  const path = join(home, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hephaestus-install-"));
  paths = resolvePaths({ HOME: home });
  service = new FakeService();
  write(".hermes/config.yaml", "model: personal\n");
  write(".claude/CLAUDE.md", "# personal\n");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("install", () => {
  it("creates ~/.hephaestus with the config, password hash and baseline, and installs the service", () => {
    install(options());

    expect(paths.root).toBe(join(home, ".hephaestus"));
    expect(statSync(paths.root).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(paths.config, "utf8"))).toEqual({ host: "0.0.0.0", port: 7700 });

    const db = openStore(paths.state);
    expect(verifyPassword("correct horse battery", readPasswordHash(db) ?? "")).toBe(true);
    db.close();

    const baseline = JSON.parse(readFileSync(paths.baseline, "utf8")) as {
      entries: Record<string, string>;
    };
    expect(baseline.entries[".hermes/config.yaml"]).toMatch(/^sha256:/);

    expect(service.calls).toEqual(["install"]);
    expect(service.unit).toContain("ExecStart=/usr/bin/node /opt/hephaestus/dist/cli.js serve");
  });

  it("refuses to install over an existing install", () => {
    install(options());

    expect(() => {
      install(options());
    }).toThrow(AlreadyInstalledError);
    expect(service.calls).toEqual(["install"]);
  });

  it("rejects a short password before creating anything", () => {
    expect(() => {
      install({ ...options(), password: "short" });
    }).toThrow(/at least 12 characters/);
    expect(existsSync(paths.root)).toBe(false);
  });
});

describe("uninstall", () => {
  it("removes the service and ~/.hephaestus and reports no drift when nothing changed", () => {
    install(options());

    const drift = uninstall({ paths, service });

    expect(drift).toEqual([]);
    expect(existsSync(paths.root)).toBe(false);
    expect(service.calls).toEqual(["install", "remove"]);
  });

  it("reports each baseline entry that changed after install", () => {
    install(options());
    write(".claude/CLAUDE.md", "# edited\n");
    write(".codex/config.toml", "model = 'x'\n");

    const drift = uninstall({ paths, service });

    expect(drift.map((change) => change.path)).toEqual([".claude/CLAUDE.md", ".codex/config.toml"]);
    expect(existsSync(paths.root)).toBe(false);
  });

  it("refuses when there is no install", () => {
    expect(() => uninstall({ paths, service })).toThrow(NotInstalledError);
    expect(service.calls).toEqual([]);
  });
});
