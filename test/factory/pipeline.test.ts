import { describe, expect, it } from "vitest";
import { MergeConflictError, MergeOutcomeUnknownError } from "../../src/factory/github.js";
import { T3ToolError } from "../../src/t3/connection.js";
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

/** A finished setup thread, such as a deploy, recorded on worker w1. */
function setupThread(h: Harness, threadId: string): void {
  h.events.recordThread({
    environmentId: "w1",
    threadId,
    title: "Hephaestus: deploy config",
    providerInstanceId: "hephaestus-claude",
    model: "m",
    configVersion: 1,
    cardId: null,
    kind: "setup",
  });
  h.events.setStatus("w1", threadId, "completed");
}

/** A card the lead restarted while the factory was paused, so its new brief waits to be sent. */
async function queuedRestart(h: Harness): Promise<number> {
  const id = admitted(h);
  await h.pipeline.startWork(id, "brief");
  h.cards.update(id, { prNumber: 5, headSha: SHA });
  h.github.prs.set(5, pr(5, SHA));
  await h.pipeline.escalateToOwner(id, "check the PR");
  await h.pipeline.sendToLead(id, "go on");
  h.pipeline.setPaused(true);
  await h.pipeline.startWork(id, "new brief");
  return id;
}

describe("Pipeline", () => {
  it("launches on the branch a card already has, so a replayed launch matches its thread", async () => {
    const h = harness();
    const id = admitted(h);
    h.cards.update(id, { branch: "factory/card-1" });

    await h.pipeline.startWork(id, "Add the flag to the CLI.");

    expect(h.t3.launches[0]?.workspace).toMatchObject({ branch: "factory/card-1" });
    expect(h.t3.launches[0]?.message).toContain("refs/hephaestus/evidence/card-1");
    expect(h.cards.get(id).branch).toBe("factory/card-1");
  });

  it("takes a card from Admitted to Done with review on the other provider and no human step", async () => {
    const h = harness();
    const id = admitted(h);

    await h.pipeline.startWork(id, "Add the flag to the CLI.");
    const implement = h.t3.launches[0];
    expect(implement).toMatchObject({
      environmentId: "w1",
      projectId: "proj",
      providerInstanceId: FACTORY_CLAUDE,
      workspace: { type: "worktree", baseRef: "origin/main", branch: "factory/0123abcd-card-1" },
    });
    expect(implement?.message).toContain("Please add --flag.");
    expect(implement?.message).toContain("Closes #5");
    expect(implement?.message).toContain("refs/hephaestus/evidence/0123abcd-card-1");
    expect(h.cards.get(id).stage).toBe("Implementing");

    h.github.prs.set(5, pr(5, SHA));
    h.finish("t1", implementResult(5, SHA));
    await h.pipeline.tick();
    expect(h.cards.get(id).stage).toBe("Reviewing");
    const review = h.t3.launches[1];
    expect(review?.providerInstanceId).toBe(FACTORY_CODEX);
    expect(review?.message).toContain(SHA);
    expect(review?.workspace).toMatchObject({ branch: "review/0123abcd-card-1-1" });

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
    // The revert is reviewed as a rollback, not against the issue it undoes.
    expect(review?.message).toContain("It reverts PR #5");
    expect(review?.message).toContain("do not judge this PR against the issue");
    expect(review?.message).not.toContain("does what the issue asks");
    h.finish(`t${String(h.t3.launches.length)}`, reviewResult("approve", SHA2));
    await h.pipeline.tick();

    expect(h.github.merged).toEqual([5, 9]);
    expect(h.github.reopened).toEqual([5]);
    expect(h.cards.notifications()[0]?.text).toMatch(/Reverted PR #5/);
    expect(h.cards.get(id)).toMatchObject({ stage: "Implementing", prNumber: null });

    await h.pipeline.tick();
    expect(h.t3.launches.at(-1)?.message).toContain("reverted");
    expect(h.t3.launches.at(-1)?.workspace).toMatchObject({
      branch: "factory/0123abcd-card-1-retry-9",
    });
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

  it("sends a conflicting revert PR to the owner, whether GitHub refuses it or reports it first", async () => {
    for (const refused of [true, false]) {
      const h = harness((config) => {
        config.projects["octo/app"] = { policy: { preset: "yolo", overrides: {} } };
      });
      const id = admitted(h);
      await h.pipeline.startWork(id, "brief");
      h.github.prs.set(5, pr(5, SHA));
      h.finish("t1", implementResult(5, SHA));
      await h.pipeline.tick();
      h.github.commits.set(MERGE, checks("failure", ["ci"], ["ci"]));
      await h.pipeline.tick();
      if (refused) {
        const merge = h.github.merge.bind(h.github);
        h.github.merge = (repo: string, number: number, head: string) =>
          number === 9 ? Promise.reject(new MergeConflictError(9)) : merge(repo, number, head);
        h.github.prs.set(9, pr(9, SHA2, { headBranch: "revert-5" }));
      } else {
        h.github.prs.set(
          9,
          pr(9, SHA2, { headBranch: "revert-5", mergeable: "CONFLICTING", checks: "none" }),
        );
      }
      await h.pipeline.tick();
      expect(h.github.merged).toEqual([5]);
      expect(h.cards.get(id)).toMatchObject({
        stage: "Escalated",
        escalatedTo: "owner",
        ownerAction: "revert-merge",
      });
      expect(h.cards.get(id).reason).toMatch(/revert PR #9 conflicts with the default branch/);
    }
  });

  it("tells the owner of a conflicting revert PR before reviewing it", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    h.github.commits.set(MERGE, checks("failure", ["ci"], ["ci"]));
    await h.pipeline.tick();
    const launches = h.t3.launches.length;
    const revert = h.github.prs.get(9);
    if (revert === undefined) throw new Error("no revert PR");
    h.github.prs.set(9, { ...revert, mergeable: "CONFLICTING" });
    await h.pipeline.tick();
    expect(h.t3.launches).toHaveLength(launches);
    expect(h.cards.get(id)).toMatchObject({ stage: "Escalated", ownerAction: "revert-merge" });
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
    h.cards.recordMerge("octo/app", 12, MERGE, id, false);

    await h.pipeline.sendToLead(id, "look again");
    expect(h.cards.get(id).escalatedTo).toBe("lead");
  });

  it("finishes a revert the owner merged by hand while the checks API is down", async () => {
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

    h.github.prs.set(
      9,
      pr(9, SHA2, { headBranch: "revert-5", state: "MERGED", mergeSha: "f".repeat(40) }),
    );
    h.github.pullRequest = () => Promise.reject(new Error("HTTP 503 from the checks API"));
    h.setClock(Date.parse("2026-11-25T13:00:00Z"));
    await h.pipeline.tick();
    await h.pipeline.tick();
    expect(h.cards.get(id)).toMatchObject({ stage: "Implementing", reverting: false });
    expect(h.github.reopened).toEqual([5]);
  });

  it("finishes a merge in flight under its last policy when its project is removed, and finds a project by any casing", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    expect(h.cards.get(id).stage).toBe("Validating");
    delete h.config.projects["octo/app"];
    // The merge fails its checks after the project is gone: it is still reverted.
    h.github.commits.set(MERGE, checks("failure", ["ci"], ["ci"]));
    await h.pipeline.tick();
    expect(h.cards.get(id)).toMatchObject({ stage: "Reverting", revertPr: 9 });
    expect(h.github.reverted).toEqual([5]);
    await h.pipeline.tick();
    h.finish(`t${String(h.t3.launches.length)}`, reviewResult("approve", SHA2));
    await h.pipeline.tick();
    expect(h.github.merged).toEqual([5, 9]);
    expect(h.github.reopened).toEqual([5]);
    // Back in Implementing, new work waits until the project is added again.
    await h.pipeline.tick();
    expect(h.cards.get(id).waiting).toMatch(/no longer a factory project/);

    // The project comes back under GitHub's spelling; a card recorded as Octo/App still finds it.
    const other = harness((config) => {
      config.projects = { "octo/app": { policy: { preset: "standard", overrides: {} } } };
    });
    const card = other.cards.create({ repo: "Octo/App", issueNumber: 5, title: "Old casing" }).id;
    other.github.issues.set(5, { number: 5, title: "x", body: "", author: "x", state: "OPEN" });
    await other.pipeline.startWork(card, "brief");
    expect(other.t3.launches).toHaveLength(1);
  });

  it("merges under the snapshot this pass recorded, when the project is removed mid-pass", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.finish("t2", reviewResult("approve", SHA));
    // The project turns strict; while the gate reads the PR, the project is removed.
    h.config.projects["octo/app"] = { policy: { preset: "strict", overrides: {} } };
    h.github.commits.set(SHA, checks("success", ["ci"]));
    const read = h.github.pullRequest.bind(h.github);
    h.github.pullRequest = async (repo, number) => {
      delete h.config.projects["octo/app"];
      return read(repo, number);
    };
    await h.pipeline.tick();
    expect(h.github.merged).toEqual([]);
    expect(h.cards.get(id)).toMatchObject({ stage: "Escalated", ownerAction: "merge" });
  });

  it("keeps the policy in force at approval when the project is removed during the board update", async () => {
    let removeDuringMirror = false;
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.config.projects["octo/app"] = { policy: { preset: "strict", overrides: {} } };
    h.github.commits.set(SHA, checks("success", ["ci"]));
    const board = h.pipeline as unknown as { mirror: (...args: unknown[]) => Promise<void> };
    const mirror = board.mirror.bind(h.pipeline);
    board.mirror = async (...args: unknown[]) => {
      if (removeDuringMirror) delete h.config.projects["octo/app"];
      return mirror(...args);
    };
    removeDuringMirror = true;
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    expect(h.github.merged).toEqual([]);
    expect(h.cards.get(id)).toMatchObject({ stage: "Escalated", ownerAction: "merge" });
  });

  it("starts no new merge for a removed project, though its review approves", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    delete h.config.projects["octo/app"];
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    expect(h.cards.get(id).stage).toBe("Reviewing");
    expect(h.cards.get(id).waiting).toMatch(/no longer a factory project/);
    expect(h.github.merged).toEqual([]);
  });

  it("records the policy of a card already validating, so its project's removal cannot strand it", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    // As after an upgrade that added the snapshot: the card has none yet.
    h.cards.update(id, { policy: null });
    await h.pipeline.tick();
    delete h.config.projects["octo/app"];
    h.github.commits.set(MERGE, checks("failure", ["ci"], ["ci"]));
    await h.pipeline.tick();
    expect(h.github.reverted).toEqual([5]);
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

  it("sends a PR that conflicts with its base back to the engineer, then escalates after the rounds", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.github.merge = (_repo, number) => Promise.reject(new MergeConflictError(number));
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    expect(h.cards.get(id)).toMatchObject({ stage: "Implementing", rounds: 1, reviewThread: null });
    expect(h.t3.sends.at(-1)).toMatchObject({ threadId: "t1" });
    expect(h.t3.sends.at(-1)?.message).toContain("conflicts with `main`");
    expect(h.cards.events(id)).toContainEqual(
      expect.objectContaining({
        kind: "stage:Implementing",
        detail: "the PR conflicts with its base branch",
      }),
    );

    h.db.prepare("UPDATE cards SET rounds = 99, stage = 'Merging' WHERE id = ?").run(id);
    await h.pipeline.tick();
    expect(h.cards.get(id)).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });
    expect(h.cards.get(id).reason).toMatch(/conflicts with main after 99 rounds/);
  });

  it("sends a PR GitHub reports conflicting back before waiting on checks that will never run", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.github.prs.set(5, pr(5, SHA, { mergeable: "CONFLICTING", checks: "none" }));
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    expect(h.github.merged).toEqual([]);
    expect(h.cards.get(id)).toMatchObject({ stage: "Implementing", rounds: 1 });
    expect(h.t3.sends.at(-1)?.message).toContain("conflicts with `main`");
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

    // The merge went through after all, with Hephaestus's marker: the scan for merges made
    // elsewhere hands it to the merge step, which validates it like any of its merges.
    other.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    other.github.ownMerges.add(MERGE);
    other.setClock(Date.parse("2026-11-25T13:00:00Z"));
    await other.pipeline.tick();
    await other.pipeline.tick();
    expect(other.cards.get(card)).toMatchObject({ stage: "Validating", foreignMerge: false });
    expect(other.cards.mergedByHephaestus("octo/app", 5)).toBe(true);
  });

  it("validates its own merge that a restarted implementer reports, and says when it cannot tell", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.startWork(id, "brief");
    // Hephaestus merged PR 5 on an earlier attempt, and the reply was lost.
    h.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    h.github.ownMerges.add(MERGE);
    const read = h.github.mergedWith.bind(h.github);
    h.github.mergedWith = () => Promise.resolve(undefined);
    h.finish("t1", implementResult(5, SHA));
    await h.pipeline.tick();
    expect(h.cards.get(id)).toMatchObject({
      stage: "Implementing",
      waiting: "reading back whether the merge was Hephaestus's",
    });

    h.github.mergedWith = read;
    await h.pipeline.tick();
    await h.pipeline.tick();
    expect(h.cards.get(id)).toMatchObject({ stage: "Validating", foreignMerge: false });
  });

  it("skips a card abandoned while the scan for outside merges reads another, and goes on after an error", async () => {
    const h = harness();
    // Three escalated cards whose PRs Hephaestus merged; the scan reads them newest first.
    const ids = [5, 6, 7].map((number) => {
      const id = h.cards.create({ repo: "octo/app", issueNumber: number, title: "Work" }).id;
      const sha = String(number).repeat(40);
      h.cards.transition(id, "Implementing", "work started", { prNumber: number, headSha: sha });
      h.cards.transition(id, "Escalated", "to the owner: check the PR", {
        escalatedTo: "owner",
        reason: "check the PR",
      });
      h.github.prs.set(number, pr(number, sha, { state: "MERGED", mergeSha: sha }));
      h.github.ownMerges.add(sha);
      return id;
    });
    const [oldest, middle] = ids as [number, number, number];
    const reads: number[] = [];
    const read = h.github.mergeState.bind(h.github);
    h.github.mergeState = async (repo, number) => {
      reads.push(number);
      if (number === 7) await h.pipeline.abandon(middle, "not needed");
      return read(repo, number);
    };
    const marker = h.github.mergedWith.bind(h.github);
    h.github.mergedWith = (repo, sha) =>
      sha === "7".repeat(40) ? Promise.reject(new Error("unexpected")) : marker(repo, sha);

    await h.pipeline.tick();
    expect(reads).not.toContain(6);
    expect(h.cards.get(middle).stage).toBe("Abandoned");
    expect(h.cards.get(oldest).stage).not.toBe("Escalated");
  });

  it("marks the implementer's result handled when its own merge is found, whichever read sees the marker", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.startWork(id, "brief");
    // A restarted card still carries the PR of its earlier attempt, which the scan reads.
    h.cards.update(id, { prNumber: 5, headSha: SHA });
    h.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    h.github.ownMerges.add(MERGE);
    const marker = h.github.mergedWith.bind(h.github);
    let calls = 0;
    h.github.mergedWith = (repo, sha) => {
      calls += 1;
      return calls === 1 ? Promise.resolve(undefined) : marker(repo, sha);
    };
    h.finish("t1", implementResult(5, SHA));
    await h.pipeline.tick();
    await h.pipeline.tick();
    await h.pipeline.tick();

    expect(h.cards.get(id).stage).toBe("Validating");
    expect(h.cards.get(id).handled.t1).toBeDefined();
  });

  it("records the PR and head of an outside merge a restarted implementer reports", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.startWork(id, "brief");
    // The card still names the PR of an earlier attempt; the implementer reports a new one,
    // which someone merged by hand.
    h.cards.update(id, { prNumber: 4, headSha: SHA2 });
    h.github.prs.set(4, pr(4, SHA2));
    h.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    h.finish("t1", implementResult(5, SHA));
    await h.pipeline.tick();
    expect(h.cards.get(id)).toMatchObject({
      stage: "Done",
      foreignMerge: true,
      prNumber: 5,
      headSha: SHA,
    });
    expect(h.cards.notifications()[0]?.text).toContain("PR #5 ");
  });

  it("keeps a card whose merge outcome is unknown from the lead, and validates the merge on approval", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.github.merge = (_repo, number) => {
      // GitHub merges, and the reply is lost.
      h.github.prs.set(number, pr(number, SHA, { state: "MERGED", mergeSha: MERGE }));
      h.github.ownMerges.add(MERGE);
      return Promise.reject(new MergeOutcomeUnknownError(number));
    };
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    expect(h.cards.get(id)).toMatchObject({ stage: "Escalated", ownerAction: "merge" });

    // Sending it to the lead settles the merge instead of restarting work on top of it.
    await expect(h.pipeline.sendToLead(id, "start over")).rejects.toThrow(/validate the merge/);
    expect(h.cards.get(id).stage).toBe("Merging");
    await h.pipeline.tick();
    expect(h.cards.get(id)).toMatchObject({ stage: "Validating", foreignMerge: false });
  });

  it("settles a restart queued before GitHub reported the merge, instead of sending it", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.startWork(id, "brief");
    h.cards.update(id, { prNumber: 5, headSha: SHA });
    h.github.prs.set(5, pr(5, SHA));
    await h.pipeline.escalateToOwner(id, "check the PR");
    await h.pipeline.sendToLead(id, "go on");
    h.pipeline.setPaused(true);
    await h.pipeline.startWork(id, "new brief");
    expect(h.cards.get(id).pendingMessage).not.toBeNull();

    h.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    h.github.ownMerges.add(MERGE);
    const sends = h.t3.sends.length;
    h.pipeline.setPaused(false);
    await h.pipeline.tick();
    await h.pipeline.tick();
    expect(h.t3.sends).toHaveLength(sends);
    expect(h.cards.get(id)).toMatchObject({ stage: "Validating", pendingMessage: null });
  });

  it("validates a queued restart's merge while paused, and keeps the message while unsure", async () => {
    const h = harness();
    const id = await queuedRestart(h);
    h.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    h.github.ownMerges.add(MERGE);
    const marker = h.github.mergedWith.bind(h.github);
    h.github.mergedWith = () => Promise.resolve(undefined);
    await h.pipeline.tick();
    expect(h.cards.get(id).stage).toBe("Implementing");
    expect(h.cards.get(id).pendingMessage).not.toBeNull();
    h.github.mergedWith = marker;
    // The scan for outside merges runs every few minutes and hands on a card waiting to send.
    h.setClock(Date.parse("2026-11-25T12:10:00Z"));
    await h.pipeline.tick();
    await h.pipeline.tick();
    expect(h.cards.get(id)).toMatchObject({ stage: "Validating", pendingMessage: null });
  });

  it("reads no merge state for a queued message while a pause holds it", async () => {
    const h = harness();
    await queuedRestart(h);
    const state = h.github.mergeState.bind(h.github);
    let reads = 0;
    h.github.mergeState = (repo, number) => {
      reads += 1;
      return state(repo, number);
    };
    await h.pipeline.tick();
    await h.pipeline.tick();
    await h.pipeline.tick();
    // Only the scan for outside merges reads, once in its interval; the held send reads nothing.
    expect(reads).toBe(1);
  });

  it("sends nothing on a read that went stale while another card held the launch queue", async () => {
    const h = harness();
    const id = await queuedRestart(h);
    h.cards.transition(id, "Escalated", "to the lead: again", { escalatedTo: "lead" });
    h.pipeline.setPaused(false);
    // Another card's launch holds the launch queue until released.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launch = h.t3.launchThread.bind(h.t3);
    h.t3.launchThread = async (options) => {
      await held;
      return launch(options);
    };
    h.github.issues.set(6, { number: 6, title: "Other", body: "", author: "x", state: "OPEN" });
    const other = h.cards.create({ repo: "octo/app", issueNumber: 6, title: "Other" }).id;
    const otherStart = h.pipeline.startWork(other, "brief");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const sends = h.t3.sends.length;
    const restart = h.pipeline.startWork(id, "newer brief");
    await new Promise((resolve) => setTimeout(resolve, 10));
    // GitHub reports the merge while the restart waits for the queue.
    h.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    h.github.ownMerges.add(MERGE);
    release();
    await otherStart;
    await restart.catch(() => undefined);

    expect(h.t3.sends).toHaveLength(sends);
    expect(h.cards.get(id).stage).not.toBe("Implementing");
  });

  it("says why a queued message waits when the PR cannot be read, and sends nothing", async () => {
    const h = harness();
    const id = await queuedRestart(h);
    h.pipeline.setPaused(false);
    h.github.mergeState = () => Promise.reject(new Error("HTTP 503"));
    const sends = h.t3.sends.length;
    await h.pipeline.tick();
    expect(h.t3.sends).toHaveLength(sends);
    expect(h.cards.get(id).waiting).toBe("reading whether the PR has merged");
  });

  it("holds a queued message when a pause lands during the merge read", async () => {
    const h = harness();
    const id = await queuedRestart(h);
    h.pipeline.setPaused(false);
    const state = h.github.mergeState.bind(h.github);
    h.github.mergeState = (repo, number) => {
      h.pipeline.setPaused(true);
      return state(repo, number);
    };
    const sends = h.t3.sends.length;
    await h.pipeline.tick();
    expect(h.t3.sends).toHaveLength(sends);
    expect(h.cards.get(id).pendingMessage).not.toBeNull();
  });

  it("hands on a merged card from the scan while the files and checks API is down", async () => {
    const h = harness();
    const id = await queuedRestart(h);
    h.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    h.github.pullRequest = () => Promise.reject(new Error("HTTP 503 from the checks API"));
    await h.pipeline.tick();
    expect(h.cards.get(id)).toMatchObject({ stage: "Done", foreignMerge: true });
  });

  it("does not send a queued message to a worker that stopped being ready during the read", async () => {
    const h = harness();
    const id = await queuedRestart(h);
    h.pipeline.setPaused(false);
    const state = h.github.mergeState.bind(h.github);
    h.github.mergeState = (repo, number) => {
      // The owner turns the worker off while the PR is read.
      h.ready.length = 0;
      return state(repo, number);
    };
    const sends = h.t3.sends.length;
    h.setClock(Date.parse("2026-11-25T12:00:30Z"));
    await h.pipeline.tick();
    expect(h.t3.sends).toHaveLength(sends);
    expect(h.cards.get(id).pendingMessage).not.toBeNull();
  });

  it("restarts a card whose open PR's checks cannot be read", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.startWork(id, "brief");
    h.cards.update(id, { prNumber: 5, headSha: SHA });
    h.github.prs.set(5, pr(5, SHA));
    await h.pipeline.escalateToOwner(id, "check the PR");
    await h.pipeline.sendToLead(id, "go on");
    // The full PR read also reads files and checks; the restart guard needs only the merge state.
    h.github.pullRequest = () => Promise.reject(new Error("HTTP 503 from the checks API"));
    expect((await h.pipeline.startWork(id, "new brief")).stage).toBe("Implementing");
  });

  it("settles an unrecorded merge when the lead restarts the card, whoever merged it", async () => {
    const h = harness();
    const ours = admitted(h);
    await h.pipeline.startWork(ours, "brief");
    h.cards.update(ours, { prNumber: 5, headSha: SHA });
    // The hand-back's read saw the PR still open; by start_work, GitHub reports the merge.
    await h.pipeline.escalateToOwner(ours, "check the PR");
    h.github.prs.set(5, pr(5, SHA));
    await h.pipeline.sendToLead(ours, "go on");
    h.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    h.github.ownMerges.add(MERGE);
    await expect(h.pipeline.startWork(ours, "new brief")).rejects.toThrow(/validate the merge/);
    expect(h.cards.get(ours).stage).toBe("Merging");

    // Merged by hand: the owner is told the card is done, not to approve it.
    const other = harness();
    const theirs = admitted(other);
    await other.pipeline.startWork(theirs, "brief");
    other.cards.update(theirs, { prNumber: 5, headSha: SHA });
    await other.pipeline.escalateToOwner(theirs, "checks fail");
    other.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    await expect(other.pipeline.sendToLead(theirs, "fix it")).rejects.toThrow(
      /outside Hephaestus, so the card is done/,
    );
    expect(other.cards.get(theirs)).toMatchObject({ stage: "Done", foreignMerge: true });
  });

  it("settles a card's threads once it is done, and keeps those of an active or escalated card", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    // The implement thread has ended, but the card is still in review.
    await h.pipeline.tick();
    await h.pipeline.settleThreads();
    expect(h.t3.settled).toEqual([]);

    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    h.github.commits.set(MERGE, checks("success", ["ci"]));
    await h.pipeline.tick();
    expect(h.cards.get(id).stage).toBe("Done");
    await h.pipeline.settleThreads();
    expect(h.t3.settled.sort()).toEqual(["t1", "t2"]);
    // Each thread is settled once.
    await h.pipeline.settleThreads();
    expect(h.t3.settled).toHaveLength(2);

    const other = harness();
    const card = admitted(other);
    await other.pipeline.startWork(card, "brief");
    other.finish("t1", "no result block");
    await other.pipeline.tick();
    expect(other.cards.get(card).stage).toBe("Escalated");
    await other.pipeline.settleThreads();
    expect(other.t3.settled).toEqual([]);
  });

  it("settles a replaced thread and a finished setup thread", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.finish("t2", reviewResult("changes", SHA));
    // A newer review thread replaces the finished one.
    h.cards.update(id, { reviewThread: "t9" });
    setupThread(h, "setup-1");
    await h.pipeline.settleThreads();
    expect(h.t3.settled.sort()).toEqual(["setup-1", "t2"]);
  });

  it("keeps ticking while a settle call hangs", async () => {
    const h = harness();
    setupThread(h, "setup-1");
    h.t3.settle = () => new Promise<void>(() => undefined);
    const id = admitted(h);
    await h.pipeline.tick();
    await h.pipeline.startWork(id, "brief");
    // A second pass runs although the first settle never returned.
    await h.pipeline.tick();
    expect(h.t3.launches).toHaveLength(1);
  });

  it("retries a thread after a worker outage, and lets the others through while one keeps failing", async () => {
    const h = harness();
    setupThread(h, "setup-1");
    setupThread(h, "setup-2");
    const settle = h.t3.settle.bind(h.t3);
    let down = true;
    h.t3.settle = (environmentId, threadId) =>
      threadId === "setup-1" && down
        ? Promise.reject(
            new T3ToolError("t3_thread_organize", "orchestration_error", "the worker is offline"),
          )
        : settle(environmentId, threadId);

    await h.pipeline.settleThreads();
    expect(h.t3.settled).toEqual(["setup-2"]);
    expect(h.events.unsettledEnded().map((thread) => thread.threadId)).toEqual(["setup-1"]);

    // It waits out its backoff, then the worker is back.
    down = false;
    await h.pipeline.settleThreads();
    expect(h.t3.settled).toEqual(["setup-2"]);
    h.setClock(Date.parse("2026-11-25T12:05:00Z"));
    await h.pipeline.settleThreads();
    expect(h.t3.settled).toEqual(["setup-2", "setup-1"]);
  });

  it("does not settle a thread a card picked up again during the pass", async () => {
    const h = harness();
    setupThread(h, "old-1");
    setupThread(h, "old-2");
    const id = h.cards.create({ repo: "octo/app", issueNumber: 5, title: "Work" }).id;
    h.cards.transition(id, "Implementing", "work started");
    const settle = h.t3.settle.bind(h.t3);
    h.t3.settle = (environmentId, threadId) => {
      // While the first call is out, the card takes up the second thread.
      if (threadId === "old-1") h.cards.update(id, { implementThread: "old-2" });
      return settle(environmentId, threadId);
    };
    await h.pipeline.settleThreads();
    expect(h.t3.settled).toEqual(["old-1"]);
  });

  it("counts a failed settle's backoff from when the call failed", async () => {
    const h = harness();
    setupThread(h, "slow");
    let clock = Date.parse("2026-11-25T12:00:00Z");
    h.t3.settle = () => {
      // The call times out ten minutes later.
      clock += 10 * 60_000;
      h.setClock(clock);
      return Promise.reject(new Error("timed out"));
    };
    await h.pipeline.settleThreads();
    let calls = 0;
    h.t3.settle = () => {
      calls += 1;
      return Promise.resolve();
    };
    h.setClock(clock + 30_000);
    await h.pipeline.settleThreads();
    expect(calls).toBe(0);
  });

  it("tries a healthy thread before older ones whose settles time out", async () => {
    const h = harness();
    for (let index = 0; index < 20; index += 1) setupThread(h, `slow-${String(index)}`);
    let clock = Date.parse("2026-11-25T12:00:00Z");
    const settle = h.t3.settle.bind(h.t3);
    h.t3.settle = (environmentId, threadId) => {
      if (!threadId.startsWith("slow-")) return settle(environmentId, threadId);
      clock += 10 * 60_000;
      h.setClock(clock);
      return Promise.reject(new Error("timed out"));
    };
    await h.pipeline.settleThreads();
    // A newer thread on a healthy worker ends after the slow ones were all tried once.
    setupThread(h, "healthy");
    await h.pipeline.settleThreads();
    expect(h.t3.settled).toContain("healthy");
  });

  it("settles a thread that ends while a pass's slow calls are out, before the rest of the pass", async () => {
    const h = harness();
    for (let index = 0; index < 5; index += 1) setupThread(h, `slow-${String(index)}`);
    const order: string[] = [];
    const settle = h.t3.settle.bind(h.t3);
    h.t3.settle = (environmentId, threadId) => {
      order.push(threadId);
      // The healthy thread ends while the first slow call is out.
      if (threadId === "slow-0") setupThread(h, "healthy");
      return threadId.startsWith("slow-")
        ? Promise.reject(new Error("timed out"))
        : settle(environmentId, threadId);
    };
    await h.pipeline.settleThreads();
    expect(order[1]).toBe("healthy");
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
