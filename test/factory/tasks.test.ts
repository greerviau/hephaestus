import { describe, expect, it } from "vitest";
import { TaskStore, TRANSITIONS, TransitionError } from "../../src/factory/tasks.js";
import { STAGES, type Stage } from "../../src/hermes/board.js";
import { openStore } from "../../src/store.js";

/** A task in `stage`, reached through allowed transitions from Admitted. */
function taskIn(store: TaskStore, stage: Stage): number {
  const id = store.create({ repo: "octo/app", issueNumber: 1, title: "t" }).id;
  const path: Record<Stage, Stage[]> = {
    Admitted: [],
    Implementing: ["Implementing"],
    Reviewing: ["Implementing", "Reviewing"],
    Merging: ["Implementing", "Reviewing", "Merging"],
    Validating: ["Implementing", "Reviewing", "Merging", "Validating"],
    Reverting: ["Implementing", "Reviewing", "Merging", "Validating", "Reverting"],
    Escalated: ["Escalated"],
    Done: ["Implementing", "Reviewing", "Merging", "Validating", "Done"],
    Abandoned: ["Abandoned"],
  };
  for (const step of path[stage]) store.transition(id, step, "setup");
  return id;
}

describe("the stage diagram", () => {
  for (const from of STAGES) {
    for (const to of STAGES) {
      const allowed = TRANSITIONS[from].includes(to);
      it(`${allowed ? "allows" : "refuses"} ${from} -> ${to}`, () => {
        const store = new TaskStore(openStore(":memory:"));
        const id = taskIn(store, from);
        if (allowed) {
          expect(store.transition(id, to, "test").stage).toBe(to);
          expect(store.events(id).at(-1)).toMatchObject({ kind: `stage:${to}`, detail: "test" });
        } else {
          expect(() => store.transition(id, to, "test")).toThrow(TransitionError);
          expect(store.get(id).stage).toBe(from);
        }
      });
    }
  }

  it("has no way out of Done or Abandoned", () => {
    expect(TRANSITIONS.Done).toEqual([]);
    expect(TRANSITIONS.Abandoned).toEqual([]);
  });
});

describe("reviews", () => {
  it("counts only an approval by another provider on the exact head commit", () => {
    const store = new TaskStore(openStore(":memory:"));
    const id = store.create({ repo: "octo/app", issueNumber: 1, title: "t" }).id;
    const base = { taskId: id, threadId: "r", author: "claude" as const };
    store.recordReview({ ...base, headSha: "old", reviewer: "codex", verdict: "approve" });
    store.recordReview({ ...base, headSha: "new", reviewer: "claude", verdict: "approve" });
    expect(store.approvedAt(id, "new")).toBe(false);
    store.recordReview({ ...base, headSha: "new", reviewer: "codex", verdict: "approve" });
    expect(store.approvedAt(id, "new")).toBe(true);
  });
});
