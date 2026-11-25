import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SystemdUserService,
  UNIT_MARKER,
  UnitExistsError,
  unitFile,
  type RunResult,
} from "../src/service.js";

let dir: string;
let unitPath: string;
let calls: string[];
let responses: Record<string, RunResult>;

function service(): SystemdUserService {
  return new SystemdUserService(unitPath, (command, args) => {
    const call = [command, ...args].join(" ");
    calls.push(call);
    return responses[call] ?? { status: 0, stdout: "" };
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hephaestus-service-"));
  unitPath = join(dir, "systemd/user/hephaestus.service");
  calls = [];
  responses = {};
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("unitFile", () => {
  it("marks the unit and quotes each ExecStart argument for systemd", () => {
    const unit = unitFile("/usr/bin/node", "/opt/Factory Tools/100%/$HOME/dist/cli.js");

    expect(unit.split("\n")[0]).toBe(UNIT_MARKER);
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/opt/Factory Tools/100%%/$$HOME/dist/cli.js" "serve"',
    );
  });
});

describe("SystemdUserService.install", () => {
  it("writes the unit, reloads systemd, and enables and starts the service", () => {
    service().install(unitFile("/usr/bin/node", "/opt/cli.js"));

    expect(readFileSync(unitPath, "utf8")).toContain(UNIT_MARKER);
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now hephaestus.service",
    ]);
  });

  it("refuses to overwrite an existing unit file", () => {
    mkdirSync(join(dir, "systemd/user"), { recursive: true });
    writeFileSync(unitPath, "[Unit]\nDescription=the owner's own unit\n");

    expect(() => {
      service().install(unitFile("/usr/bin/node", "/opt/cli.js"));
    }).toThrow(UnitExistsError);
    expect(readFileSync(unitPath, "utf8")).toContain("the owner's own unit");
    expect(calls).toEqual([]);
  });

  it("refuses a symlink at the unit path", () => {
    mkdirSync(join(dir, "systemd/user"), { recursive: true });
    symlinkSync(join(dir, "elsewhere.service"), unitPath);

    expect(() => {
      service().install(unitFile("/usr/bin/node", "/opt/cli.js"));
    }).toThrow(UnitExistsError);
    expect(existsSync(join(dir, "elsewhere.service"))).toBe(false);
  });

  it("fails when systemd cannot start the service", () => {
    responses["systemctl --user enable --now hephaestus.service"] = { status: 1, stdout: "" };

    expect(() => {
      service().install(unitFile("/usr/bin/node", "/opt/cli.js"));
    }).toThrow(/enable --now hephaestus.service/);
  });
});

describe("SystemdUserService.remove", () => {
  it("stops the service, then deletes the unit and reloads systemd", () => {
    service().install(unitFile("/usr/bin/node", "/opt/cli.js"));
    calls = [];
    responses["systemctl --user is-active hephaestus.service"] = {
      status: 3,
      stdout: "inactive\n",
    };

    service().remove();

    expect(existsSync(unitPath)).toBe(false);
    expect(calls).toEqual([
      "systemctl --user disable --now hephaestus.service",
      "systemctl --user is-active hephaestus.service",
      "systemctl --user daemon-reload",
    ]);
  });

  it("succeeds without touching systemd when there is no unit", () => {
    service().remove();

    expect(calls).toEqual([]);
  });

  it("leaves a unit that Hephaestus did not write", () => {
    mkdirSync(join(dir, "systemd/user"), { recursive: true });
    writeFileSync(unitPath, "[Unit]\nDescription=the owner's own unit\n");

    expect(() => {
      service().remove();
    }).toThrow(/not written by Hephaestus/);
    expect(existsSync(unitPath)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("keeps the unit when the service is still running after the stop", () => {
    service().install(unitFile("/usr/bin/node", "/opt/cli.js"));
    responses["systemctl --user disable --now hephaestus.service"] = { status: 1, stdout: "" };
    responses["systemctl --user is-active hephaestus.service"] = { status: 0, stdout: "active\n" };

    expect(() => {
      service().remove();
    }).toThrow(/still active/);
    expect(existsSync(unitPath)).toBe(true);
  });
});
