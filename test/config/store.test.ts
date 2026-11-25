import type { Database } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigValidationError } from "../../src/config/document.js";
import { ConfigStore } from "../../src/config/store.js";
import { openStore } from "../../src/store.js";
import { sampleConfig } from "./fixtures.js";

let db: Database;
let store: ConfigStore;

beforeEach(() => {
  db = openStore(":memory:");
  store = new ConfigStore(db, () => new Date("2026-11-25T03:00:00Z"));
});

function deployed(document = sampleConfig()) {
  const first = store.createVersion({ document, author: "install", message: "First version" });
  store.approve(first.id);
  store.markDeployed(first.id);
  return store.get(first.id);
}

describe("versions", () => {
  it("records each change as a new draft with a diff against its parent", () => {
    const first = deployed();
    const document = sampleConfig();
    document.roles.lead.persona = "Lead carefully.";
    document.projects["octo/app"] = {
      policy: { preset: "standard", overrides: { maxReviewRounds: 3 } },
    };

    const second = store.createVersion({
      document,
      author: "owner",
      message: "Tune the lead",
      parentId: first.id,
    });

    expect(second).toMatchObject({ id: 2, parentId: 1, state: "draft", author: "owner" });
    expect(store.diff(second.id)).toEqual([
      {
        path: ["projects", "octo/app", "policy", "overrides", "maxReviewRounds"],
        before: undefined,
        after: 3,
      },
      { path: ["roles", "lead", "persona"], before: "Lead the work.", after: "Lead carefully." },
    ]);
    expect(store.list().map((version) => version.id)).toEqual([2, 1]);
  });

  it("diffs the first version against an empty config", () => {
    const first = store.createVersion({ document: sampleConfig(), author: "install", message: "" });

    expect(store.diff(first.id).map((change) => change.path[0])).toContain("roles");
  });

  it("rejects an invalid document", () => {
    const document = sampleConfig() as unknown as Record<string, unknown>;
    document.roles = { planner: { persona: 3 } };

    expect(() =>
      store.createVersion({ document: document as never, author: "owner", message: "" }),
    ).toThrow(ConfigValidationError);
  });

  it("rejects a project override that is not a policy setting", () => {
    const document = sampleConfig();
    document.projects["octo/app"] = {
      policy: { preset: "standard", overrides: { merge: "yes" } as Record<string, unknown> },
    };

    expect(() => store.createVersion({ document, author: "owner", message: "" })).toThrow(
      /overrides\.merge/,
    );
  });

  it("requires a parent once a version exists", () => {
    deployed();

    expect(() =>
      store.createVersion({ document: sampleConfig(), author: "owner", message: "" }),
    ).toThrow(/parent/);
  });
});

describe("states", () => {
  it("moves a draft through approved and deployed, and supersedes the previous deployed version", () => {
    const first = deployed();
    const second = store.createVersion({
      document: sampleConfig(),
      author: "owner",
      message: "",
      parentId: first.id,
    });

    store.approve(second.id);
    store.markDeployed(second.id);

    expect(store.get(first.id).state).toBe("superseded");
    expect(store.get(second.id).state).toBe("deployed");
    expect(store.current()?.id).toBe(second.id);
  });

  it("rejects a draft and refuses transitions from the wrong state", () => {
    const first = store.createVersion({ document: sampleConfig(), author: "owner", message: "" });

    expect(() => {
      store.markDeployed(first.id);
    }).toThrow(/approved/);
    store.reject(first.id);
    expect(store.get(first.id).state).toBe("rejected");
    expect(() => {
      store.approve(first.id);
    }).toThrow(/draft/);
  });
});

describe("revert", () => {
  it("restores what a deployed version changed and keeps later unrelated changes", () => {
    const first = deployed();

    const tuned = sampleConfig();
    tuned.roles.lead.persona = "Lead carefully.";
    const second = store.createVersion({
      document: tuned,
      author: "improver",
      message: "",
      parentId: first.id,
    });
    store.approve(second.id);
    store.markDeployed(second.id);

    const later = structuredClone(tuned);
    later.instructions.factory = "# Newer instructions\n";
    const third = store.createVersion({
      document: later,
      author: "owner",
      message: "",
      parentId: second.id,
    });
    store.approve(third.id);
    store.markDeployed(third.id);

    const { version, conflicts } = store.revert(second.id, "owner");

    expect(conflicts).toEqual([]);
    expect(version).toMatchObject({ parentId: third.id, state: "draft", author: "owner" });
    expect(version.message).toBe("Revert version 2");
    expect(version.document.roles.lead.persona).toBe("Lead the work.");
    expect(version.document.instructions.factory).toBe("# Newer instructions\n");
  });

  it("leaves a value that a later version changed again and reports it as a conflict", () => {
    const first = deployed();
    const tuned = sampleConfig();
    tuned.roles.lead.persona = "Lead carefully.";
    const second = store.createVersion({
      document: tuned,
      author: "improver",
      message: "",
      parentId: first.id,
    });
    store.approve(second.id);
    store.markDeployed(second.id);
    const again = structuredClone(tuned);
    again.roles.lead.persona = "Lead very carefully.";
    const third = store.createVersion({
      document: again,
      author: "owner",
      message: "",
      parentId: second.id,
    });
    store.approve(third.id);
    store.markDeployed(third.id);

    const { version, conflicts } = store.revert(second.id, "owner");

    expect(conflicts.map((change) => change.path)).toEqual([["roles", "lead", "persona"]]);
    expect(version.document.roles.lead.persona).toBe("Lead very carefully.");
  });

  it("removes a value the reverted version added", () => {
    const first = deployed();
    const added = sampleConfig();
    added.projects["octo/other"] = { policy: { preset: "yolo", overrides: {} } };
    const second = store.createVersion({
      document: added,
      author: "owner",
      message: "",
      parentId: first.id,
    });
    store.approve(second.id);
    store.markDeployed(second.id);

    const { version } = store.revert(second.id, "owner");

    expect(Object.keys(version.document.projects)).toEqual(["octo/app"]);
  });

  it("refuses to revert a version that was never deployed", () => {
    const first = deployed();
    const draft = store.createVersion({
      document: sampleConfig(),
      author: "owner",
      message: "",
      parentId: first.id,
    });

    expect(() => store.revert(draft.id, "owner")).toThrow(/deployed/);
  });
});
