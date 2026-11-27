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
  responses = { "systemctl --user cat hephaestus.service": { status: 1, stdout: "" } };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("unitFile", () => {
  it("marks the unit, turns off variable expansion, and quotes each ExecStart argument", () => {
    const unit = unitFile("/opt/n$de/node", '/opt/Factory Tools/100%/"q"/dist/cli.js');

    expect(unit.split("\n")[0]).toBe(UNIT_MARKER);
    expect(unit).toContain(
      'ExecStart=:"/opt/n$de/node" "/opt/Factory Tools/100%%/\\"q\\"/dist/cli.js" "serve"',
    );
  });

  it("refuses a path with a line break", () => {
    expect(() => unitFile("/usr/bin/node", "/opt/a\nb/cli.js")).toThrow(/line break/);
  });
});

describe("SystemdUserService.install", () => {
  it("writes the unit, reloads systemd, and enables and starts the service", () => {
    service().install(unitFile("/usr/bin/node", "/opt/cli.js"));

    expect(readFileSync(unitPath, "utf8")).toContain(UNIT_MARKER);
    expect(calls).toEqual([
      "systemctl --user cat hephaestus.service",
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

  it("refuses when systemd already knows a unit with the same name elsewhere", () => {
    responses["systemctl --user cat hephaestus.service"] = { status: 0, stdout: "# /elsewhere\n" };

    expect(() => {
      service().install(unitFile("/usr/bin/node", "/opt/cli.js"));
    }).toThrow(UnitExistsError);
    expect(existsSync(unitPath)).toBe(false);
    expect(calls).toEqual(["systemctl --user cat hephaestus.service"]);
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

  it("succeeds when there is no unit and no service is running", () => {
    responses["systemctl --user is-active hephaestus.service"] = {
      status: 3,
      stdout: "inactive\n",
    };

    service().remove();

    expect(calls).toEqual(["systemctl --user is-active hephaestus.service"]);
  });

  it("refuses when the unit file is gone but the service still runs", () => {
    responses["systemctl --user is-active hephaestus.service"] = { status: 0, stdout: "active\n" };

    expect(() => {
      service().remove();
    }).toThrow(/still active/);
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

  it("stops only a unit Hephaestus wrote, and leaves it in place", () => {
    mkdirSync(join(dir, "systemd/user"), { recursive: true });
    writeFileSync(unitPath, "[Unit]\nDescription=the owner's own unit\n");
    expect(() => {
      service().stop();
    }).toThrow(/not written by Hephaestus/);
    expect(calls).toEqual([]);

    writeFileSync(unitPath, unitFile("/usr/bin/node", "/opt/cli.js"));
    responses["systemctl --user is-active hephaestus.service"] = {
      status: 3,
      stdout: "inactive\n",
    };
    service().stop();
    expect(calls).toEqual([
      "systemctl --user show -P FragmentPath hephaestus.service",
      "systemctl --user stop hephaestus.service",
      "systemctl --user is-active hephaestus.service",
    ]);
    expect(existsSync(unitPath)).toBe(true);

    calls.length = 0;
    responses["systemctl --user show -P FragmentPath hephaestus.service"] = {
      status: 0,
      stdout: "/etc/systemd/user/hephaestus.service\n",
    };
    expect(() => {
      service().stop();
    }).toThrow(/leaving it running/);
    expect(calls).not.toContain("systemctl --user stop hephaestus.service");
  });

  it("keeps the unit when systemd cannot be reached", () => {
    service().install(unitFile("/usr/bin/node", "/opt/cli.js"));
    responses["systemctl --user disable --now hephaestus.service"] = { status: 1, stdout: "" };
    responses["systemctl --user is-active hephaestus.service"] = { status: 1, stdout: "" };

    expect(() => {
      service().remove();
    }).toThrow(/disable --now/);
    expect(existsSync(unitPath)).toBe(true);
  });

  it("keeps the unit when the service is still running after the stop", () => {
    service().install(unitFile("/usr/bin/node", "/opt/cli.js"));
    responses["systemctl --user is-active hephaestus.service"] = { status: 0, stdout: "active\n" };

    expect(() => {
      service().remove();
    }).toThrow(/still active/);
    expect(existsSync(unitPath)).toBe(true);
  });
});

describe("SystemdUserService with another unit", () => {
  it("acts on the unit named by its file", () => {
    const other = join(dir, "systemd/user/hephaestus-hermes-gateway.service");
    new SystemdUserService(other, (command, args) => {
      calls.push([command, ...args].join(" "));
      return { status: args[1] === "cat" ? 1 : 0, stdout: "" };
    }).install(unitFile("/usr/bin/node", "/opt/cli.js"));

    expect(calls).toEqual([
      "systemctl --user cat hephaestus-hermes-gateway.service",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now hephaestus-hermes-gateway.service",
    ]);
  });
});

describe("SystemdUserService.stopped", () => {
  it("is true only when systemd reports the service inactive or failed", () => {
    for (const [stdout, stopped] of [
      ["inactive\n", true],
      ["failed\n", true],
      ["active\n", false],
      ["activating\n", false],
      ["deactivating\n", false],
      ["", false],
    ] as const) {
      responses["systemctl --user is-active hephaestus.service"] = { status: 3, stdout };
      expect(service().stopped()).toBe(stopped);
    }
  });
});

describe("SystemdUserService.active", () => {
  it("is true while systemd runs the service or brings it up, and false while it stops", () => {
    for (const [stdout, active] of [
      ["active\n", true],
      ["activating\n", true],
      ["reloading\n", true],
      ["refreshing\n", true],
      ["deactivating\n", false],
      ["inactive\n", false],
      ["failed\n", false],
      ["", false],
    ] as const) {
      responses["systemctl --user is-active hephaestus.service"] = { status: 0, stdout };
      expect(service().active()).toBe(active);
    }
  });
});
