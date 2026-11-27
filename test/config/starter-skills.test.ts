import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import {
  offerStarterSkills,
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
    expect(draft?.document.roles.planner.skills).toEqual(["triage", "write-issue"]);

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
        [first.name]: starterDigest({ "SKILL.md": "an older shipped text\n" }),
        [second.name]: starterDigest({ "SKILL.md": "an older shipped text\n" }),
      }),
    );

    offerStarterSkills({ db, store });
    const draft = store.list()[0];
    expect(draft?.author).toBe("hephaestus");
    expect(draft?.document.skills[first.name]).toEqual(first.files);
    expect(draft?.document.skills[second.name]).toEqual({ "SKILL.md": "the owner's own text\n" });
    db.close();
  });
});
