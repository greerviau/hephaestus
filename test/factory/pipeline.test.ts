import { describe, expect, it } from "vitest";
import { FACTORY_CLAUDE, FACTORY_CODEX } from "../../src/workers/manager.js";
import {
  MERGE,
  SHA,
  SHA2,
  harness,
  implementResult,
  pr,
  reviewResult,
  type Harness,
} from "./harness.js";

function admitted(h: Harness): number {
  h.github.issues.set(5, {
    number: 5,
    title: "Add a flag",
    body: "Please add --flag.",
    author: "owner",
    state: "OPEN",
  });
  return h.cards.create({ repo: "octo/app", issueNumber: 5, title: "Add a flag" }).id;
}

/** Starts the card and takes it to Reviewing with PR 5 at SHA. */
async function toReview(h: Harness, id: number): Promise<void> {
  await h.pipeline.startWork(id, "Add the flag to the CLI.");
  h.github.prs.set(5, pr(5, SHA));
  h.finish("t1", implementResult(5, SHA));
  await h.pipeline.tick();
}

describe("Pipeline", () => {
  it("takes a card from Admitted to Done with review on the other provider and no human step", async () => {
    const h = harness();
    const id = admitted(h);

    await h.pipeline.startWork(id, "Add the flag to the CLI.");
    const implement = h.t3.launches[0];
    expect(implement).toMatchObject({
      environmentId: "w1",
      projectId: "proj",
      providerInstanceId: FACTORY_CLAUDE,
      workspace: { type: "worktree", baseRef: "origin/main", branch: "factory/card-1" },
    });
    expect(implement?.message).toContain("Please add --flag.");
    expect(implement?.message).toContain("Closes #5");
    expect(h.cards.get(id).stage).toBe("Implementing");

    h.github.prs.set(5, pr(5, SHA));
    h.finish("t1", implementResult(5, SHA));
    await h.pipeline.tick();
    expect(h.cards.get(id).stage).toBe("Reviewing");
    const review = h.t3.launches[1];
    expect(review?.providerInstanceId).toBe(FACTORY_CODEX);
    expect(review?.message).toContain(SHA);

    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    expect(h.github.merged).toEqual([5]);
    expect(h.cards.get(id)).toMatchObject({ stage: "Validating", mergeSha: MERGE });

    h.github.commits.set(MERGE, { state: "success", failed: [] });
    await h.pipeline.tick();
    expect(h.cards.get(id).stage).toBe("Done");

    for (const threadId of ["t1", "t2"]) {
      expect(h.events.thread("w1", threadId)).toMatchObject({
        cardId: String(id),
        configVersion: 3,
      });
    }
    expect(h.events.thread("w1", "t1")?.providerInstanceId).toBe(FACTORY_CLAUDE);
    expect(h.events.thread("w1", "t2")?.providerInstanceId).toBe(FACTORY_CODEX);
  });

  it("sends review findings to the implement thread while rounds remain, then escalates to the lead", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);

    h.finish("t2", reviewResult("changes", SHA, "1. src/app.ts:3 handle the empty case"));
    await h.pipeline.tick();
    expect(h.cards.get(id)).toMatchObject({ stage: "Implementing", rounds: 1 });
    expect(h.t3.sends.at(-1)).toMatchObject({ threadId: "t1" });
    expect(h.t3.sends.at(-1)?.message).toContain("handle the empty case");

    h.github.prs.set(5, pr(5, SHA2));
    h.finish("t1", implementResult(5, SHA2));
    await h.pipeline.tick();
    expect(h.cards.get(id).stage).toBe("Reviewing");
    h.finish("t3", reviewResult("changes", SHA2, "1. still wrong"));
    await h.pipeline.tick();
    h.github.prs.set(5, pr(5, SHA));
    h.finish("t1", implementResult(5, SHA));
    await h.pipeline.tick();
    h.finish("t4", reviewResult("changes", SHA, "1. still wrong"));
    await h.pipeline.tick();

    expect(h.cards.get(id)).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });
    expect(h.cards.get(id).reason).toMatch(/after 2 rounds/);
  });

  it("escalates to the lead on a failed thread, a missing result, or a question", async () => {
    for (const [text, status, reason] of [
      ["", "failed", /ended failed/],
      ["All done!", "completed", /no valid result block/],
      ["", "waiting", /asked a question/],
    ] as const) {
      const h = harness();
      const id = admitted(h);
      await h.pipeline.startWork(id, "brief");
      h.finish("t1", text, status);
      await h.pipeline.tick();
      expect(h.cards.get(id)).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });
      expect(h.cards.get(id).reason).toMatch(reason);
    }
  });

  it("does not take a review of an older head commit", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.finish("t2", reviewResult("approve", SHA2));
    await h.pipeline.tick();
    expect(h.github.merged).toEqual([]);
    expect(h.cards.get(id).reason).toMatch(/covered/);
  });

  it("stops before merging a PR that touches an escalation path, until the owner approves that head", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.github.prs.set(5, pr(5, SHA, { files: ["src/app.ts", ".github/workflows/ci.yml"] }));
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();

    expect(h.github.merged).toEqual([]);
    expect(h.cards.get(id)).toMatchObject({ stage: "Escalated", escalatedTo: "owner" });
    expect(h.cards.get(id).reason).toBe(
      "the PR touches an escalation path: .github/workflows/ci.yml",
    );
    expect(h.cards.notifications()[0]?.text).toMatch(/needs you/);

    expect(() => h.pipeline.approveMerge(id, SHA2)).toThrow();
    h.pipeline.approveMerge(id, SHA);
    await h.pipeline.tick();
    expect(h.github.merged).toEqual([5]);
  });

  it("merges without review under yolo", async () => {
    const h = harness((config) => {
      config.projects["octo/app"] = { policy: { preset: "yolo", overrides: {} } };
    });
    const id = admitted(h);
    await h.pipeline.startWork(id, "brief");
    h.github.prs.set(5, pr(5, SHA));
    h.finish("t1", implementResult(5, SHA));
    await h.pipeline.tick();
    expect(h.t3.launches).toHaveLength(1);
    expect(h.github.merged).toEqual([5]);
  });

  it("waits for running checks and escalates failing ones", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.github.prs.set(5, pr(5, SHA, { checks: "pending" }));
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    expect(h.cards.get(id)).toMatchObject({ stage: "Merging", waiting: "checks are running" });

    h.github.prs.set(5, pr(5, SHA, { checks: "failure", failedChecks: ["test"] }));
    await h.pipeline.tick();
    expect(h.cards.get(id)).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });
  });

  it("starts no thread while paused or at a cap, and says why", async () => {
    const h = harness((config) => {
      config.factory.limits.threadsPerWorker = 1;
    });
    const first = admitted(h);
    h.pipeline.setPaused(true);
    await h.pipeline.startWork(first, "brief");
    expect(h.t3.launches).toHaveLength(0);
    expect(h.cards.get(first).waiting).toBe("The factory is paused.");

    h.pipeline.setPaused(false);
    await h.pipeline.tick();
    expect(h.t3.launches).toHaveLength(1);

    const second = h.cards.create({ repo: "octo/app", issueNumber: 5, title: "Again" }).id;
    await h.pipeline.startWork(second, "brief");
    expect(h.t3.launches).toHaveLength(1);
    expect(h.cards.get(second).waiting).toMatch(/worker's limit of 1/);
  });

  it("holds back a daily start cap and a missing worker", async () => {
    const h = harness((config) => {
      config.factory.limits.startsPerDay = 0;
    });
    const id = admitted(h);
    await h.pipeline.startWork(id, "brief");
    expect(h.cards.get(id).waiting).toMatch(/per day/);

    const other = harness();
    other.ready.length = 0;
    const card = admitted(other);
    await other.pipeline.startWork(card, "brief");
    expect(other.cards.get(card).waiting).toBe("No worker is ready.");
  });

  it("reverts a merge whose checks fail on the default branch, reopens the issue, and starts again", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    h.github.commits.set(MERGE, { state: "failure", failed: ["build"] });
    await h.pipeline.tick();
    expect(h.cards.get(id)).toMatchObject({ stage: "Reverting", revertPr: 9 });
    expect(h.github.reverted).toEqual([5]);

    await h.pipeline.tick();
    expect(h.github.merged).toEqual([5, 9]);
    expect(h.github.reopened).toEqual([5]);
    expect(h.cards.notifications()[0]?.text).toMatch(/Reverted PR #5/);
    const card = h.cards.get(id);
    expect(card).toMatchObject({ stage: "Implementing", prNumber: null });

    await h.pipeline.tick();
    expect(h.t3.launches.at(-1)?.message).toContain("reverted");
    expect(h.t3.launches.at(-1)?.workspace).toMatchObject({ branch: "factory/card-1-retry-9" });
  });

  it("flags a factory PR merged outside Hephaestus", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    // Foreign merges are checked every five minutes.
    h.setClock(Date.parse("2026-11-25T12:06:00Z"));
    await h.pipeline.tick();
    expect(h.cards.get(id).foreignMerge).toBe(true);
    expect(h.cards.notifications()[0]?.text).toMatch(/merged outside Hephaestus/);
  });

  it("starts an admitted card itself when the lead has not, after the configured delay", async () => {
    const h = harness((config) => {
      config.factory.autoStartMinutes = 10;
    });
    const id = admitted(h);
    await h.pipeline.tick();
    expect(h.t3.launches).toHaveLength(0);
    h.setClock(Date.parse("2026-11-25T12:11:00Z"));
    await h.pipeline.tick();
    expect(h.cards.get(id).stage).toBe("Implementing");
    expect(h.t3.launches).toHaveLength(1);
  });

  it("lets the lead restart an escalated card in its implement thread", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.startWork(id, "brief");
    h.finish("t1", "stuck", "completed");
    await h.pipeline.tick();
    expect(h.cards.get(id).stage).toBe("Escalated");

    await h.pipeline.startWork(id, "Try the other parser.");
    expect(h.cards.get(id).stage).toBe("Implementing");
    expect(h.t3.sends.at(-1)?.message).toContain("Try the other parser.");
  });

  it("refuses start_work on a card that is with the owner", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.escalateToOwner(id, "needs a product decision");
    await expect(h.pipeline.startWork(id, "brief")).rejects.toThrow(/with the owner/);
  });
});
