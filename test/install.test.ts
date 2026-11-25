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
import {
  AlreadyInstalledError,
  NotInstalledError,
  install,
  installedUnitPath,
  uninstall,
} from "../src/install.js";
import { resolvePaths, type Paths } from "../src/paths.js";
import { UnitExistsError, type ServiceManager } from "../src/service.js";
import { openStore } from "../src/store.js";

class FakeService implements ServiceManager {
  calls: string[] = [];
  unit: string | undefined;
  installError: Error | undefined;
  removeError: Error | undefined;
  install(unit: string): void {
    this.calls.push("install");
    if (this.installError) throw this.installError;
    this.unit = unit;
  }
  remove(): void {
    this.calls.push("remove");
    if (this.removeError) throw this.removeError;
    this.unit = undefined;
  }
}

let home: string;
let paths: Paths;
let service: FakeService;
let readyChecks: number;

const options = () => ({
  paths,
  service,
  password: "correct horse battery",
  port: 7700,
  nodePath: "/usr/bin/node",
  cliPath: "/opt/hephaestus/dist/cli.js",
  waitForReady: () => {
    readyChecks += 1;
    return Promise.resolve();
  },
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
  readyChecks = 0;
  write(".hermes/config.yaml", "model: personal\n");
  write(".claude/CLAUDE.md", "# personal\n");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("install", () => {
  it("creates ~/.hephaestus with the config, password hash and baseline, and starts the service", async () => {
    await install(options());

    expect(paths.root).toBe(join(home, ".hephaestus"));
    expect(statSync(paths.root).mode & 0o777).toBe(0o700);
    const config = JSON.parse(readFileSync(paths.config, "utf8")) as Record<string, unknown>;
    expect(config).toMatchObject({ host: "0.0.0.0", port: 7700, unitPath: paths.unit });
    expect(config.instanceId).toMatch(/^[0-9a-f-]{36}$/);

    const db = openStore(paths.state);
    expect(await verifyPassword("correct horse battery", readPasswordHash(db) ?? "")).toBe(true);
    db.close();

    const baseline = JSON.parse(readFileSync(paths.baseline, "utf8")) as {
      entries: Record<string, string>;
    };
    expect(baseline.entries[".hermes/config.yaml"]).toMatch(/^sha256:/);

    expect(service.calls).toEqual(["install"]);
    expect(service.unit).toContain(
      'ExecStart=:"/usr/bin/node" "/opt/hephaestus/dist/cli.js" "serve"',
    );
    expect(readyChecks).toBe(1);
  });

  it("refuses to install over an existing install", async () => {
    await install(options());

    await expect(install(options())).rejects.toThrow(AlreadyInstalledError);
    expect(service.calls).toEqual(["install"]);
  });

  it.each([
    ["short", /at least 12 characters/],
    ["x".repeat(257), /at most 256 characters/],
  ])("rejects the password %# before creating anything", async (password, message) => {
    await expect(install({ ...options(), password })).rejects.toThrow(message);
    expect(existsSync(paths.root)).toBe(false);
  });

  it("rolls back the service and ~/.hephaestus when the dashboard never answers", async () => {
    await expect(
      install({ ...options(), waitForReady: () => Promise.reject(new Error("port in use")) }),
    ).rejects.toThrow(/port in use/);

    expect(existsSync(paths.root)).toBe(false);
    expect(service.calls).toEqual(["install", "remove"]);
  });

  it("rolls back ~/.hephaestus when systemd fails to start the service", async () => {
    service.installError = new Error("enable failed");

    await expect(install(options())).rejects.toThrow(/enable failed/);

    expect(existsSync(paths.root)).toBe(false);
    expect(service.calls).toEqual(["install", "remove"]);
  });

  it("keeps the install record when rolling back the service also fails", async () => {
    service.removeError = new Error("still active");

    await expect(
      install({ ...options(), waitForReady: () => Promise.reject(new Error("port in use")) }),
    ).rejects.toThrow(/port in use[\s\S]*still active/);

    expect(existsSync(paths.config)).toBe(true);
    expect(existsSync(paths.baseline)).toBe(true);
  });

  it("leaves an existing unit alone and removes only its own state", async () => {
    service.installError = new UnitExistsError(paths.unit);

    await expect(install(options())).rejects.toThrow(UnitExistsError);

    expect(existsSync(paths.root)).toBe(false);
    expect(service.calls).toEqual(["install"]);
  });
});

describe("uninstall", () => {
  it("removes the service and ~/.hephaestus and reports no drift when nothing changed", async () => {
    await install(options());

    const result = uninstall({ paths, service });

    expect(result.drift).toEqual([]);
    expect(existsSync(paths.root)).toBe(false);
    expect(service.calls).toEqual(["install", "remove"]);
  });

  it("reports each baseline entry that changed after install", async () => {
    await install(options());
    write(".claude/CLAUDE.md", "# edited\n");
    write(".codex/config.toml", "model = 'x'\n");

    const result = uninstall({ paths, service });

    expect(result.drift?.map((change) => change.path)).toEqual([
      ".claude/CLAUDE.md",
      ".codex/config.toml",
    ]);
    expect(existsSync(paths.root)).toBe(false);
  });

  it("still removes everything when the baseline is unreadable, and says drift is unknown", async () => {
    await install(options());
    writeFileSync(paths.baseline, "{ not json");

    const result = uninstall({ paths, service });

    expect(result.drift).toBeUndefined();
    expect(existsSync(paths.root)).toBe(false);
  });

  it("keeps ~/.hephaestus when the service cannot be removed", async () => {
    await install(options());
    service.removeError = new Error("still active");

    expect(() => uninstall({ paths, service })).toThrow(/still active/);
    expect(existsSync(paths.baseline)).toBe(true);
  });

  it("uses the unit path recorded at install", async () => {
    await install(options());

    expect(installedUnitPath(paths)).toBe(paths.unit);
  });

  it("refuses when there is no install", () => {
    expect(() => uninstall({ paths, service })).toThrow(NotInstalledError);
    expect(service.calls).toEqual([]);
  });

  it("refuses a ~/.hephaestus that install did not create", () => {
    mkdirSync(paths.root);
    writeFileSync(join(paths.root, "notes.txt"), "the owner's own file\n");

    expect(() => uninstall({ paths, service })).toThrow(NotInstalledError);
    expect(existsSync(join(paths.root, "notes.txt"))).toBe(true);
  });
});
