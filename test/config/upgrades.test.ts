import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, shippedPersona } from "../../src/config/defaults.js";
import { ConfigStore } from "../../src/config/store.js";
import { LEGACY_PERSONAS, applyUpgrades } from "../../src/config/upgrades.js";
import { FactoryProfiles } from "../../src/hermes/profiles.js";
import { getMeta } from "../../src/meta.js";
import { openStore } from "../../src/store.js";
import { FakeHermes } from "../hermes/fake-hermes.js";

let db: Database;
let store: ConfigStore;

beforeEach(() => {
  db = openStore(":memory:");
  store = new ConfigStore(db);
});

afterEach(() => {
  db.close();
});

/** An install made before the communicator persona: the old stock persona, deployed. */
function oldInstall(persona: string = LEGACY_PERSONAS.planner[0] ?? ""): number {
  const document = defaultConfig([]);
  document.roles.planner.persona = persona;
  const first = store.createVersion({ document, author: "install", message: "First version" });
  store.approve(first.id);
  store.markDeployed(first.id);
  return first.id;
}

function deployer(): {
  deploy: (id: number) => Promise<{ hermesError?: string }>;
  deployed: number[];
} {
  const deployed: number[] = [];
  return {
    deployed,
    deploy: (id) => {
      if (store.get(id).state === "approved") store.markDeployed(id);
      deployed.push(id);
      return Promise.resolve({});
    },
  };
}

describe("applyUpgrades", () => {
  it("keeps the old stock persona text as the one the shipped template replaced", () => {
    expect(LEGACY_PERSONAS.planner[0]).toContain("Turn each request in your channel");
    expect(shippedPersona("planner")).not.toBe(LEGACY_PERSONAS.planner[0]);
  });

  it("replaces an unedited old planner persona with a new version that is deployed", async () => {
    const first = oldInstall();
    const { deploy, deployed } = deployer();

    await applyUpgrades({ db, store, deploy });

    const current = store.current();
    expect(current?.id).toBe(first + 1);
    expect(current?.state).toBe("deployed");
    expect(current?.parentId).toBe(first);
    expect(current?.author).toBe("upgrade");
    expect(current?.document.roles.planner.persona).toBe(shippedPersona("planner"));
    expect(deployed).toEqual([first + 1]);
    // Nothing else changed.
    expect(store.diff(first + 1).map((change) => change.path.join("."))).toEqual([
      "roles.planner.persona",
    ]);
  });

  it("matches an old persona the dashboard saved with CRLF line ends or a missing final newline", async () => {
    const edited = (LEGACY_PERSONAS.planner[0] ?? "").replaceAll("\n", "\r\n").trimEnd();
    const first = oldInstall(edited);

    await applyUpgrades({ db, store, deploy: deployer().deploy });

    expect(store.current()?.id).toBe(first + 1);
  });

  it("leaves a customized persona alone", async () => {
    const first = oldInstall(`${LEGACY_PERSONAS.planner[0] ?? ""}\nAlways answer in French.\n`);
    const { deploy, deployed } = deployer();

    await applyUpgrades({ db, store, deploy });

    expect(store.current()?.id).toBe(first);
    expect(store.count()).toBe(1);
    expect(deployed).toEqual([]);
  });

  it("runs once: a later return to the old persona is not upgraded again", async () => {
    const first = oldInstall();
    await applyUpgrades({ db, store, deploy: deployer().deploy });
    const document = structuredClone(store.current()?.document ?? defaultConfig([]));
    document.roles.planner.persona = LEGACY_PERSONAS.planner[0] ?? "";
    const back = store.createVersion({
      document,
      author: "owner",
      message: "Back to the old persona",
      parentId: first + 1,
    });
    store.approve(back.id);
    store.markDeployed(back.id);

    await applyUpgrades({ db, store, deploy: deployer().deploy });

    expect(store.current()?.id).toBe(back.id);
    expect(getMeta(db, "template_upgrades_applied")).toBe("1");
  });

  it("approves without deploying when nothing is deployed yet", async () => {
    const document = defaultConfig([]);
    document.roles.planner.persona = LEGACY_PERSONAS.planner[0] ?? "";
    const first = store.createVersion({ document, author: "install", message: "First" });
    store.approve(first.id);
    const { deploy, deployed } = deployer();

    await applyUpgrades({ db, store, deploy });

    expect(deployed).toEqual([]);
    expect(store.current()?.id).toBe(first.id + 1);
    expect(store.current()?.state).toBe("approved");
    expect(store.current()?.document.roles.planner.persona).toBe(shippedPersona("planner"));
  });

  it("retries a deploy that failed on the next start, without making another version", async () => {
    const first = oldInstall();
    await applyUpgrades({
      db,
      store,
      deploy: () => Promise.reject(new Error("the config repo is unreachable")),
    });
    expect(store.get(first + 1).state).toBe("approved");

    const { deploy, deployed } = deployer();
    await applyUpgrades({ db, store, deploy });

    expect(deployed).toEqual([first + 1]);
    expect(store.count()).toBe(2);
    expect(store.current()?.state).toBe("deployed");
  });

  it("keeps the upgrade pending when the factory Hermes root did not take it, and applies it again", async () => {
    const first = oldInstall();
    await applyUpgrades({
      db,
      store,
      deploy: (id) => {
        store.markDeployed(id);
        return Promise.resolve({ hermesError: "hermes is not reachable" });
      },
    });
    expect(store.current()?.state).toBe("deployed");
    expect(getMeta(db, "template_upgrade_pending")).toBe(String(first + 1));

    const { deploy, deployed } = deployer();
    await applyUpgrades({ db, store, deploy });

    expect(deployed).toEqual([first + 1]);
    expect(getMeta(db, "template_upgrade_pending")).toBe("");
    expect(store.count()).toBe(2);
  });

  it("makes the version and both markers together, so a failed write leaves none of them", async () => {
    const first = oldInstall();
    db.exec(`CREATE TRIGGER no_pending BEFORE INSERT ON meta WHEN NEW.key = 'template_upgrade_pending'
             BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);

    await expect(applyUpgrades({ db, store, deploy: deployer().deploy })).rejects.toThrow(
      /disk full/,
    );

    expect(store.count()).toBe(1);
    expect(store.current()?.id).toBe(first);
    expect(getMeta(db, "template_upgrades_applied")).toBeUndefined();
  });

  it("drops a pending upgrade once the owner has deployed a later version", async () => {
    const first = oldInstall();
    await applyUpgrades({
      db,
      store,
      deploy: () => Promise.reject(new Error("the config repo is unreachable")),
    });
    store.markDeployed(first + 1);
    const later = store.createVersion({
      document: structuredClone(store.get(first + 1).document),
      author: "owner",
      message: "A later edit",
      parentId: first + 1,
    });
    store.approve(later.id);
    store.markDeployed(later.id);
    const { deploy, deployed } = deployer();

    await applyUpgrades({ db, store, deploy });

    expect(deployed).toEqual([]);
    expect(getMeta(db, "template_upgrade_pending")).toBe("");
  });
});

describe("a deployed upgrade", () => {
  it("reaches the planner's Hermes profile on the next sync", async () => {
    const root = mkdtempSync(join(tmpdir(), "hephaestus-upgrade-"));
    try {
      oldInstall();
      const souls: string[] = [];
      const hermes = new FakeHermes();
      hermes.answer(
        (args) => args[0] === "profile" && args[1] === "install" && args.includes("planner"),
        (args) => {
          mkdirSync(join(root, "profiles", "planner"), { recursive: true });
          souls.push(readFileSync(join(args[2] ?? "", "SOUL.md"), "utf8"));
          return "";
        },
      );
      const profiles = new FactoryProfiles({ root, run: hermes.run }, db);
      const mcp = { url: "http://127.0.0.1:7701/mcp", tokenEnv: "TOKEN", token: "secret" };

      await applyUpgrades({
        db,
        store,
        deploy: async (id) => {
          store.markDeployed(id);
          await profiles.sync(store.get(id).document, id, mcp);
          return {};
        },
      });

      expect(souls).toEqual([shippedPersona("planner")]);
      expect(souls[0]).toContain("general communicator");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
