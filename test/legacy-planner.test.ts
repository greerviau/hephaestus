import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { SecretsFile } from "../src/config/secrets.js";
import { ConfigStore } from "../src/config/store.js";
import { normalizeConfig } from "../src/config/document.js";
import { currentRoleName, migratePlannerFiles, renameLegacyRole } from "../src/legacy-planner.js";
import { openStore } from "../src/store.js";
import { sampleConfig } from "./config/fixtures.js";
import { FakeHermes } from "./hermes/fake-hermes.js";

let dir: string;
let warn: MockInstance;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hephaestus-planner-"));
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

function secrets(): SecretsFile {
  return new SecretsFile(join(dir, "secrets.json"));
}

/** A factory Hermes root as an install that still called the chat agent the planner left it. */
function upgradedRoot(): string {
  const root = join(dir, "hermes");
  const profile = join(root, "profiles", "planner");
  mkdirSync(join(profile, "skills", "write-issue"), { recursive: true });
  mkdirSync(join(profile, "memories"), { recursive: true });
  mkdirSync(join(profile, "sessions"), { recursive: true });
  writeFileSync(join(profile, "skills", "write-issue", "SKILL.md"), "# Write an issue\n");
  writeFileSync(join(profile, "memories", "MEMORY.md"), "The owner likes short replies.\n");
  writeFileSync(join(profile, "sessions", "one.json"), '{"id":"one"}');
  writeFileSync(join(profile, ".env"), "HEPHAESTUS_MCP_TOKEN=keep-me\n");
  mkdirSync(join(root, "profiles", "lead"), { recursive: true });
  return root;
}

describe("moving the Hermes profile and its token", () => {
  it("moves an upgraded install's profile, with its skills, memories, and sessions", async () => {
    const root = upgradedRoot();
    secrets().set("hermes-mcp-token-planner", "tok");

    await migratePlannerFiles({ hermesRoot: root, secrets: secrets() });

    const moved = join(root, "profiles", "communicator");
    expect(existsSync(join(root, "profiles", "planner"))).toBe(false);
    expect(readFileSync(join(moved, "skills", "write-issue", "SKILL.md"), "utf8")).toBe(
      "# Write an issue\n",
    );
    expect(readFileSync(join(moved, "memories", "MEMORY.md"), "utf8")).toContain("short replies");
    expect(readFileSync(join(moved, "sessions", "one.json"), "utf8")).toBe('{"id":"one"}');
    expect(readFileSync(join(moved, ".env"), "utf8")).toBe("HEPHAESTUS_MCP_TOKEN=keep-me\n");
    expect(existsSync(join(root, "profiles", "lead"))).toBe(true);
    expect(secrets().get("hermes-mcp-token-communicator")).toBe("tok");
    expect(secrets().get("hermes-mcp-token-planner")).toBeUndefined();
  });

  it("does nothing on a fresh install and when run again", async () => {
    const root = join(dir, "hermes");
    await migratePlannerFiles({ hermesRoot: root, secrets: secrets() });
    expect(existsSync(join(root, "profiles"))).toBe(false);
    expect(secrets().names()).toEqual([]);

    const upgraded = upgradedRoot();
    secrets().set("hermes-mcp-token-planner", "tok");
    await migratePlannerFiles({ hermesRoot: upgraded, secrets: secrets() });
    await migratePlannerFiles({ hermesRoot: upgraded, secrets: secrets() });
    expect(readFileSync(join(upgraded, "profiles", "communicator", ".env"), "utf8")).toContain(
      "keep-me",
    );
    expect(secrets().get("hermes-mcp-token-communicator")).toBe("tok");
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves both profiles in place and says so when the new one already exists", async () => {
    const root = upgradedRoot();
    mkdirSync(join(root, "profiles", "communicator"), { recursive: true });
    secrets().set("hermes-mcp-token-planner", "old");
    secrets().set("hermes-mcp-token-communicator", "new");

    await migratePlannerFiles({ hermesRoot: root, secrets: secrets() });

    expect(existsSync(join(root, "profiles", "planner", ".env"))).toBe(true);
    expect(existsSync(join(root, "profiles", "communicator", ".env"))).toBe(false);
    expect(secrets().get("hermes-mcp-token-communicator")).toBe("new");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("already exists"));
  });
});

/** A factory gateway that records what happened to it, and whether the old profile was there. */
class FakeGateway {
  readonly events: string[] = [];
  constructor(
    private running: boolean,
    private readonly root: string,
  ) {}
  stopped(): boolean {
    return !this.running;
  }
  stop(): void {
    this.events.push(
      `stop with planner ${existsSync(join(this.root, "profiles", "planner")) ? "present" : "gone"}`,
    );
    this.running = false;
  }
  start(): void {
    this.events.push("start");
    this.running = true;
  }
}

describe("moving the profile while the factory gateway serves it", () => {
  /** A hermes that notes each call in the gateway's log, so the order shows. */
  function recordingHermes(gateway: FakeGateway, reply = ""): FakeHermes {
    const hermes = new FakeHermes();
    hermes.answer(
      () => true,
      (args) => {
        gateway.events.push(`hermes ${args.join(" ")}`);
        if (reply !== "") throw new Error(reply);
        return "";
      },
    );
    return hermes;
  }

  it("stops the gateway, moves the profile, rekeys its sessions, and starts the gateway again", async () => {
    const root = upgradedRoot();
    const gateway = new FakeGateway(true, root);

    await migratePlannerFiles({
      hermesRoot: root,
      secrets: secrets(),
      gateway,
      run: recordingHermes(gateway).run,
    });

    expect(gateway.events).toEqual([
      "stop with planner present",
      "hermes profile migrate-identity planner communicator",
      "start",
    ]);
    expect(existsSync(join(root, "profiles", "planner"))).toBe(false);
    expect(existsSync(join(root, "profiles", "communicator", ".env"))).toBe(true);
  });

  it("leaves a stopped gateway stopped and still rekeys the sessions", async () => {
    const root = upgradedRoot();
    const gateway = new FakeGateway(false, root);

    await migratePlannerFiles({
      hermesRoot: root,
      secrets: secrets(),
      gateway,
      run: recordingHermes(gateway).run,
    });

    expect(gateway.events).toEqual(["hermes profile migrate-identity planner communicator"]);
  });

  it("starts the gateway again and says how to finish when rekeying fails", async () => {
    const root = upgradedRoot();
    const gateway = new FakeGateway(true, root);

    await migratePlannerFiles({
      hermesRoot: root,
      secrets: secrets(),
      gateway,
      run: recordingHermes(gateway, "database is locked").run,
    });

    expect(gateway.events.at(-1)).toBe("start");
    expect(existsSync(join(root, "profiles", "communicator", ".env"))).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("hermes profile migrate-identity planner communicator"),
    );
  });

  it("touches neither the gateway nor Hermes when there is nothing to move", async () => {
    const root = join(dir, "hermes");
    mkdirSync(join(root, "profiles", "communicator"), { recursive: true });
    const gateway = new FakeGateway(true, root);
    const hermes = recordingHermes(gateway);

    await migratePlannerFiles({ hermesRoot: root, secrets: secrets(), gateway, run: hermes.run });

    expect(gateway.events).toEqual([]);
  });
});

describe("the old role name", () => {
  it("is accepted with a deprecation warning, and the new one without", () => {
    expect(currentRoleName("planner")).toBe("communicator");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/planner.*deprecated.*communicator/));

    expect(currentRoleName("communicator")).toBe("communicator");
    expect(currentRoleName("lead")).toBe("lead");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("works as a config key: roles.planner becomes roles.communicator and the key warns", () => {
    const old = sampleConfig() as unknown as Record<string, unknown>;
    const { communicator, ...others } = sampleConfig().roles;
    old.roles = { ...others, planner: communicator };

    const normalized = normalizeConfig(old) as { roles: Record<string, unknown> };
    expect(normalized.roles.communicator).toEqual(communicator);
    expect(Object.keys(normalized.roles)).not.toContain("planner");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("roles.planner"));

    // A store takes the old document as it is, and keeps it under the new key.
    const store = new ConfigStore(openStore(":memory:"));
    const version = store.createVersion({ document: old as never, author: "owner", message: "" });
    expect(version.document.roles.communicator.persona).toBe("Plan the work.");
    expect(Object.keys(version.document.roles)).not.toContain("planner");
  });

  it("keeps the new key when a document holds both, and leaves others alone", () => {
    const both = {
      roles: { planner: { persona: "old" }, communicator: { persona: "new" } },
    };
    expect(renameLegacyRole(both).roles).toEqual({ communicator: { persona: "new" } });
    expect(renameLegacyRole({ roles: { lead: {} } })).toEqual({ roles: { lead: {} } });
    expect(renameLegacyRole("text")).toBe("text");
    expect(both.roles).toHaveProperty("planner");
  });
});
