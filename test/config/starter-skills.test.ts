import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { defaultConfig } from "../../src/config/defaults.js";
import {
  offerStarterSkills,
  recordInstalledStarterSkills,
  skillDigest as starterDigest,
  starterSkills,
} from "../../src/config/starter-skills.js";
import { openStore } from "../../src/store.js";
import { sampleConfig } from "../config/fixtures.js";
import type { FactoryConfig } from "../../src/config/document.js";

function deployedStore(change: (config: FactoryConfig) => void = () => undefined): {
  store: ConfigStore;
  db: ReturnType<typeof openStore>;
} {
  const db = openStore(":memory:");
  const store = new ConfigStore(db);
  const document = sampleConfig();
  change(document);
  const version = store.createVersion({ document, author: "install", message: "v1" });
  store.approve(version.id);
  store.markDeployed(version.id);
  return { store, db };
}

describe("offerStarterSkills", () => {
  it("proposes the starter skills an install lacks, loaded by their jobs, once", () => {
    const { store, db } = deployedStore();

    const offered = offerStarterSkills({ db, store });
    expect(offered).toBeDefined();
    const draft = store.list()[0];
    expect(draft).toMatchObject({ state: "draft", author: "hephaestus" });
    expect(draft?.message).toMatch(/test-first/);
    expect(Object.keys(draft?.document.skills ?? {})).toEqual(
      expect.arrayContaining(starterSkills().map((skill) => skill.name)),
    );
    expect(draft?.document.factory.threadSkills).toEqual(expect.arrayContaining(["test-first"]));
    expect(draft?.document.roles.lead.skills).toEqual(["write-brief"]);
    // The owner's own skill and its loading stay.
    expect(draft?.document.skills.triage).toEqual({ "SKILL.md": "# Triage\n" });
    expect(draft?.document.roles.communicator.skills).toEqual(["triage", "write-issue"]);

    // Offered once: rejecting it does not bring it back.
    store.reject(draft?.id ?? 0);
    expect(offerStarterSkills({ db, store })).toBeUndefined();
    expect(store.list().filter((version) => version.author === "hephaestus")).toHaveLength(1);
    db.close();
  });

  it("offers nothing when no version is deployed, or when the install has the skills", () => {
    const db = openStore(":memory:");
    const store = new ConfigStore(db);
    const version = store.createVersion({
      document: sampleConfig(),
      author: "install",
      message: "",
    });
    store.approve(version.id);
    expect(offerStarterSkills({ db, store })).toBeUndefined();
    db.close();

    const current = deployedStore((config) => {
      for (const skill of starterSkills()) config.skills[skill.name] = skill.files;
    });
    expect(offerStarterSkills(current)).toBeUndefined();
    current.db.close();
  });

  it("updates a starter skill the owner left as offered, and leaves one the owner edited", () => {
    const [first, second] = starterSkills();
    if (first === undefined || second === undefined) throw new Error("no starter skills");
    const { store, db } = deployedStore((config) => {
      config.skills[first.name] = { "SKILL.md": "an older shipped text\n" };
      config.skills[second.name] = { "SKILL.md": "the owner's own text\n" };
    });
    // What an earlier build offered: the older text of the first skill, and something else for the second.
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
      "starter_skills_offered",
      JSON.stringify({
        decided: {
          [first.name]: starterDigest({ "SKILL.md": "an older shipped text\n" }),
          [second.name]: starterDigest({ "SKILL.md": "an older shipped text\n" }),
        },
      }),
    );

    offerStarterSkills({ db, store });
    const draft = store.list()[0];
    expect(draft?.author).toBe("hephaestus");
    expect(draft?.document.skills[first.name]).toEqual(first.files);
    expect(draft?.document.skills[second.name]).toEqual({ "SKILL.md": "the owner's own text\n" });
    db.close();
  });

  it("replaces a draft that another deploy left behind, and keeps a deleted starter skill out", () => {
    const { store, db } = deployedStore();
    const stranded = offerStarterSkills({ db, store });
    // The owner deploys another change first, so the draft can never be deployed.
    const base = store.current();
    if (base === undefined || stranded === undefined) throw new Error("no version");
    const edit = store.createVersion({
      document: base.document,
      author: "owner",
      message: "Another change",
      parentId: base.id,
    });
    store.approve(edit.id);
    store.markDeployed(edit.id);

    const replacement = offerStarterSkills({ db, store });
    expect(store.get(stranded.id).state).toBe("rejected");
    expect(replacement?.parentId).toBe(edit.id);

    // Deployed, then the owner deletes one: a later build does not bring it back.
    store.approve(replacement?.id ?? 0);
    store.markDeployed(replacement?.id ?? 0);
    expect(offerStarterSkills({ db, store })).toBeUndefined();
    const current = store.current();
    if (current === undefined) throw new Error("no version");
    const document = structuredClone(current.document);
    delete document.skills["write-brief"];
    document.roles.lead.skills = [];
    const without = store.createVersion({
      document,
      author: "owner",
      message: "No briefs",
      parentId: current.id,
    });
    store.approve(without.id);
    store.markDeployed(without.id);
    expect(offerStarterSkills({ db, store })).toBeUndefined();
    db.close();
  });

  it("counts the starter skills install shipped as decided, so an update can bring new text", () => {
    const db = openStore(":memory:");
    const store = new ConfigStore(db);
    const document = defaultConfig([]);
    const first = store.createVersion({ document, author: "install", message: "v1" });
    store.approve(first.id);
    recordInstalledStarterSkills(db, document);
    store.markDeployed(first.id);

    expect(offerStarterSkills({ db, store })).toBeUndefined();
    const offers = JSON.parse(
      (
        db.prepare("SELECT value FROM meta WHERE key = 'starter_skills_offered'").get() as {
          value: string;
        }
      ).value,
    ) as { decided: Record<string, string> };
    expect(Object.keys(offers.decided)).toHaveLength(starterSkills().length);
    db.close();
  });
});
