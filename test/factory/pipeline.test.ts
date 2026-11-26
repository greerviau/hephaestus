import { describe, expect, it } from "vitest";
import { MergeOutcomeUnknownError } from "../../src/factory/github.js";
import { FACTORY_CLAUDE, FACTORY_CODEX } from "../../src/workers/manager.js";
import {
  MERGE,
  SHA,
  SHA2,
  checks,
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

    h.github.commits.set(MERGE, checks("success"));
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

    await expect(h.pipeline.approveMerge(id, SHA2)).rejects.toThrow();
    await h.pipeline.approveMerge(id, SHA);
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

  it("reverts a merge whose checks fail, after reviewing the revert, reopens the issue, and starts again", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    h.github.commits.set(MERGE, checks("failure", ["ci"], ["ci"]));
    await h.pipeline.tick();
    expect(h.cards.get(id)).toMatchObject({ stage: "Reverting", revertPr: 9, headSha: null });
    expect(h.github.reverted).toEqual([5]);

    // Under standard, the revert PR gets its own review from the other provider.
    await h.pipeline.tick();
    const review = h.t3.launches.at(-1);
    expect(review?.providerInstanceId).toBe(FACTORY_CODEX);
    expect(review?.message).toContain("#9");
    h.finish(`t${String(h.t3.launches.length)}`, reviewResult("approve", SHA2));
    await h.pipeline.tick();

    expect(h.github.merged).toEqual([5, 9]);
    expect(h.github.reopened).toEqual([5]);
    expect(h.cards.notifications()[0]?.text).toMatch(/Reverted PR #5/);
    expect(h.cards.get(id)).toMatchObject({ stage: "Implementing", prNumber: null });

    await h.pipeline.tick();
    expect(h.t3.launches.at(-1)?.message).toContain("reverted");
    expect(h.t3.launches.at(-1)?.workspace).toMatchObject({ branch: "factory/card-1-retry-9" });
  });

  it("sends a revert PR that touches an escalation path to the owner", async () => {
    const h = harness((config) => {
      config.projects["octo/app"] = {
        policy: { preset: "yolo", overrides: { escalationPaths: ["ci/**"] } },
      };
    });
    const id = admitted(h);
    await h.pipeline.startWork(id, "brief");
    h.github.prs.set(5, pr(5, SHA));
    h.finish("t1", implementResult(5, SHA));
    await h.pipeline.tick();
    h.github.commits.set(MERGE, checks("failure", ["ci"], ["ci"]));
    await h.pipeline.tick();
    h.github.prs.set(9, pr(9, SHA2, { headBranch: "revert-5", files: ["ci/build.yml"] }));
    await h.pipeline.tick();

    expect(h.github.merged).toEqual([5]);
    expect(h.cards.get(id)).toMatchObject({
      stage: "Escalated",
      ownerAction: "revert-merge",
      headSha: SHA2,
    });
    // The lead would restart the reverted work, so the revert stays with the owner.
    await expect(h.pipeline.sendToLead(id, "lead, take it")).rejects.toThrow(/revert/);
    await h.pipeline.approveMerge(id, SHA2);
    await h.pipeline.tick();
    expect(h.github.merged).toEqual([5, 9]);
  });

  it("counts a revert PR the owner merged by hand", async () => {
    const h = harness((config) => {
      config.projects["octo/app"] = {
        policy: { preset: "yolo", overrides: { escalationPaths: ["ci/**"] } },
      };
    });
    const id = admitted(h);
    await h.pipeline.startWork(id, "brief");
    h.github.prs.set(5, pr(5, SHA));
    h.finish("t1", implementResult(5, SHA));
    await h.pipeline.tick();
    h.github.commits.set(MERGE, checks("failure", ["ci"], ["ci"]));
    await h.pipeline.tick();
    h.github.prs.set(9, pr(9, SHA2, { headBranch: "revert-5", files: ["ci/build.yml"] }));
    await h.pipeline.tick();
    expect(h.cards.get(id).stage).toBe("Escalated");

    // The owner merges the revert on GitHub instead of approving it on the dashboard.
    h.github.prs.set(
      9,
      pr(9, SHA2, { headBranch: "revert-5", state: "MERGED", mergeSha: "f".repeat(40) }),
    );
    h.github.reopenFailures = 1;
    h.setClock(Date.parse("2026-11-25T13:00:00Z"));
    await h.pipeline.tick();
    expect(h.cards.get(id).stage).toBe("Reverting");
    // The issue's reopen fails once; the retry a day later keeps the revert's day and logs it once.
    await h.pipeline.tick();
    expect(h.cards.get(id).stage).toBe("Reverting");
    h.setClock(Date.parse("2026-11-26T13:00:00Z"));
    await h.pipeline.tick();

    expect(h.github.merged).toEqual([5]);
    expect(h.cards.revertCount()).toBe(1);
    expect(h.cards.mergedByHephaestus("octo/app", 9)).toBe(false);
    expect(h.github.reopened).toEqual([5]);
    expect(h.cards.get(id)).toMatchObject({ stage: "Implementing", reverting: false });
    expect(h.cards.events(id).filter((event) => event.kind === "foreign-merge")).toHaveLength(1);
    expect(h.db.prepare("SELECT at FROM merges WHERE pr_number = 9").get()).toEqual({
      at: "2026-11-25T13:00:00.000Z",
    });
  });

  it("counts its own revert merge as its own when the record of it was lost", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    h.github.commits.set(MERGE, checks("failure", ["ci"], ["ci"]));
    await h.pipeline.tick();
    // Hephaestus merged the revert, and the write that records it failed.
    h.github.prs.set(
      9,
      pr(9, SHA2, { headBranch: "revert-5", state: "MERGED", mergeSha: "8".repeat(40) }),
    );
    h.github.ownMerges.add("8".repeat(40));
    await h.pipeline.tick();

    expect(h.cards.mergedByHephaestus("octo/app", 9)).toBe(true);
    expect(h.cards.events(id).some((event) => event.kind === "foreign-merge")).toBe(false);
  });

  it("lets the owner send a retried card to the lead after its earlier revert completed", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.escalateToOwner(id, "checks failed on the retry's merge commit");
    h.cards.update(id, { revertPr: 9, prNumber: 12, mergeSha: MERGE, reverting: false });

    await h.pipeline.sendToLead(id, "look again");
    expect(h.cards.get(id).escalatedTo).toBe("lead");
  });

  it("does not take a PR from another branch, and never reverts a merge it did not make", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.startWork(id, "brief");
    h.github.prs.set(6, pr(6, SHA, { headBranch: "someone/else" }));
    h.finish("t1", implementResult(6, SHA));
    await h.pipeline.tick();
    expect(h.cards.get(id).reason).toMatch(/not the card's branch/);

    const other = harness();
    const card = admitted(other);
    await toReview(other, card);
    other.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    other.finish("t2", reviewResult("approve", SHA));
    await other.pipeline.tick();
    expect(other.cards.get(card)).toMatchObject({ stage: "Done", foreignMerge: true });
    expect(other.github.reverted).toEqual([]);
  });

  it("waits for every check that ran on the PR to finish on the merge commit", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.github.prs.set(5, pr(5, SHA, { checkNames: ["ci", "lint"] }));
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    h.github.commits.set(MERGE, checks("success", ["ci"]));
    await h.pipeline.tick();
    expect(h.cards.get(id)).toMatchObject({ stage: "Validating" });
    expect(h.cards.get(id).waiting).toMatch(/lint/);

    h.github.commits.set(MERGE, checks("success", ["ci", "lint"]));
    await h.pipeline.tick();
    expect(h.cards.get(id).stage).toBe("Done");
  });

  it("merges a repo without CI only when the policy allows no checks", async () => {
    const h = harness((config) => {
      config.projects["octo/app"] = {
        policy: { preset: "standard", overrides: { allowNoChecks: true } },
      };
    });
    const id = admitted(h);
    await toReview(h, id);
    h.github.prs.set(5, pr(5, SHA, { checks: "none", checkNames: [] }));
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    expect(h.github.merged).toEqual([5]);
    h.github.commits.set(MERGE, checks("none"));
    await h.pipeline.tick();
    expect(h.cards.get(id).stage).toBe("Validating");
    h.setClock(Date.parse("2026-11-25T12:11:00Z"));
    await h.pipeline.tick();
    expect(h.cards.get(id).stage).toBe("Done");

    const strict = harness();
    const card = admitted(strict);
    await toReview(strict, card);
    strict.github.prs.set(5, pr(5, SHA, { checks: "none", checkNames: [] }));
    strict.finish("t2", reviewResult("approve", SHA));
    await strict.pipeline.tick();
    expect(strict.github.merged).toEqual([]);
    strict.setClock(Date.parse("2026-11-25T13:01:00Z"));
    await strict.pipeline.tick();
    expect(strict.cards.get(card)).toMatchObject({ stage: "Escalated", escalatedTo: "owner" });
  });

  it("retries a launch whose reply was lost without its pending launch blocking it", async () => {
    const h = harness((config) => {
      config.factory.limits.threadsPerWorker = 1;
      config.factory.limits.threads = 1;
    });
    const id = admitted(h);
    // A launch was recorded, and its reply never came.
    h.events.recordLaunch(`hephaestus-implement-${String(id)}-0`, {
      environmentId: "w1",
      title: "Card",
      providerInstanceId: FACTORY_CLAUDE,
      model: "m",
      configVersion: 3,
      cardId: String(id),
      kind: "implement",
    });
    await h.pipeline.startWork(id, "brief");
    expect(h.t3.launches).toHaveLength(1);
    expect(h.t3.launches[0]?.clientRequestId).toBe(`hephaestus-implement-${String(id)}-0`);
  });

  it("waits for required checks and for checks to register before merging", async () => {
    const h = harness((config) => {
      config.projects["octo/app"] = {
        policy: { preset: "standard", overrides: { requiredChecks: ["e2e"] } },
      };
    });
    const id = admitted(h);
    await toReview(h, id);
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    expect(h.github.merged).toEqual([]);
    expect(h.cards.get(id).waiting).toMatch(/required checks have not run: e2e/);
    h.github.prs.set(5, pr(5, SHA, { checkNames: ["check:ci", "check:e2e"] }));
    await h.pipeline.tick();
    expect(h.github.merged).toEqual([5]);
  });

  it("takes a merged PR with its marker for its own merge, and sends an unknown outcome to the owner", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    // GitHub merged the PR on an earlier pass, and the reply was lost.
    h.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    h.github.ownMerges.add(MERGE);
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    expect(h.cards.get(id)).toMatchObject({ stage: "Validating", foreignMerge: false });

    const other = harness();
    const card = admitted(other);
    await toReview(other, card);
    other.github.merge = () => Promise.reject(new MergeOutcomeUnknownError(5));
    other.finish("t2", reviewResult("approve", SHA));
    await other.pipeline.tick();
    expect(other.cards.get(card)).toMatchObject({ stage: "Escalated", escalatedTo: "owner" });
    expect(other.cards.get(card).reason).toMatch(/could not read back/);
  });

  it("does not abandon a card that started work", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.startWork(id, "brief");
    expect((await h.pipeline.abandonUnstarted(id, "the issue was closed")).stage).toBe(
      "Implementing",
    );
  });

  it("refuses a send-to-lead or abandon from a form opened before the card changed", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.escalateToOwner(id, "first question");
    // The clock stands still: both escalations share a timestamp, and only the version tells them apart.
    const seen = String(h.cards.get(id).version);
    await h.pipeline.sendToLead(id, "answer", seen);
    await h.pipeline.escalateToOwner(id, "second question");

    await expect(h.pipeline.sendToLead(id, "late answer", seen)).rejects.toThrow(/changed/);
    await expect(h.pipeline.abandon(id, "late abandon", seen)).rejects.toThrow(/changed/);
    expect(h.cards.get(id)).toMatchObject({ stage: "Escalated", reason: "second question" });
  });

  it("refuses a stale send-to-lead and an approval for another action", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.escalateToOwner(id, "needs a decision");
    await h.pipeline.sendToLead(id, "first note");
    await expect(h.pipeline.sendToLead(id, "second note")).rejects.toThrow(
      /not waiting for the owner/,
    );
    expect(h.cards.get(id).reason).toBe("first note");

    const other = harness();
    const card = admitted(other);
    await toReview(other, card);
    other.github.prs.set(5, pr(5, SHA, { files: [".github/workflows/ci.yml"] }));
    other.finish("t2", reviewResult("approve", SHA));
    await other.pipeline.tick();
    await expect(other.pipeline.approveMerge(card, SHA, "revert-merge")).rejects.toThrow();
    expect((await other.pipeline.approveMerge(card, SHA, "merge")).stage).toBe("Merging");
  });

  it("does not start work for a repo that left the factory projects", async () => {
    const h = harness();
    const id = admitted(h);
    delete h.config.projects["octo/app"];
    await h.pipeline.startWork(id, "brief");
    expect(h.t3.launches).toHaveLength(0);
    expect(h.cards.get(id).waiting).toMatch(/no longer a factory project/);
  });

  it("lets a thread waiting on the lead resume within a cap of one", async () => {
    const h = harness((config) => {
      config.factory.limits.threadsPerWorker = 1;
      config.factory.limits.threads = 1;
    });
    const id = admitted(h);
    await h.pipeline.startWork(id, "brief");
    h.finish("t1", "", "waiting");
    await h.pipeline.tick();
    expect(h.cards.get(id).stage).toBe("Escalated");
    await h.pipeline.startWork(id, "Use the v2 API.");
    expect(h.t3.sends.at(-1)?.message).toContain("Use the v2 API.");
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
