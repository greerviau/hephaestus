import { describe, expect, it } from "vitest";
import {
  MergeConflictError,
  MergeOutcomeUnknownError,
  MergeRefusedError,
} from "../../src/factory/github.js";
import type { LaunchOptions } from "../../src/t3/adapter.js";
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
  return h.tasks.create({ repo: "octo/app", issueNumber: 5, title: "Add a flag" }).id;
}

/** Starts the task and takes it to Reviewing with PR 5 at SHA. */
async function toReview(h: Harness, id: number): Promise<void> {
  await h.pipeline.queue(id, "Add the flag to the CLI.");
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
    taskId: null,
    kind: "setup",
  });
  h.events.setStatus("w1", threadId, "completed");
}

/** A task the lead restarted while the factory was paused, so its new brief waits to be sent. */
async function queuedRestart(h: Harness): Promise<number> {
  const id = admitted(h);
  await h.pipeline.queue(id, "brief");
  h.tasks.update(id, { prNumber: 5, headSha: SHA });
  h.github.prs.set(5, pr(5, SHA));
  await h.pipeline.escalateToOwner(id, "check the PR");
  await h.pipeline.sendToLead(id, "go on");
  h.pipeline.setPaused(true);
  await h.pipeline.startWork(id, "new brief");
  return id;
}

describe("Pipeline", () => {
  it("launches on the branch a task already has, so a replayed launch matches its thread", async () => {
    const h = harness();
    const id = admitted(h);
    h.tasks.update(id, { branch: "factory/task-1" });

    await h.pipeline.queue(id, "Add the flag to the CLI.");

    expect(h.t3.launches[0]?.workspace).toMatchObject({ branch: "factory/task-1" });
    expect(h.t3.launches[0]?.message).toContain("refs/hephaestus/evidence/task-1");
    expect(h.tasks.get(id).branch).toBe("factory/task-1");
  });

  it("takes a task from Admitted to Done with review on the other provider and no human step", async () => {
    const h = harness();
    const id = admitted(h);

    await h.pipeline.queue(id, "Add the flag to the CLI.");
    const implement = h.t3.launches[0];
    expect(implement).toMatchObject({
      environmentId: "w1",
      projectId: "proj",
      providerInstanceId: FACTORY_CLAUDE,
      workspace: { type: "worktree", baseRef: "origin/main", branch: "factory/0123abcd-task-1" },
    });
    expect(implement?.message).toContain("Please add --flag.");
    expect(implement?.message).toContain("Closes #5");
    expect(implement?.message).toContain("Nobody watches this thread");
    expect(implement?.message).toContain("--force-with-lease");
    expect(implement?.message).toContain("Before this thread has opened a PR");
    expect(implement?.message).toContain("only the task");
    expect(implement?.message).toContain("refs/hephaestus/evidence/0123abcd-task-1");
    expect(h.tasks.get(id).stage).toBe("Implementing");

    h.github.prs.set(5, pr(5, SHA));
    h.finish("t1", implementResult(5, SHA));
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).toBe("Reviewing");
    const review = h.t3.launches[1];
    expect(review?.providerInstanceId).toBe(FACTORY_CODEX);
    expect(review?.message).toContain(SHA);
    expect(review?.message).toContain("Nobody watches this thread");
    expect(review?.message).toContain("contribution rules");
    expect(review?.workspace).toMatchObject({ branch: "review/0123abcd-task-1-1" });

    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    expect(h.github.merged).toEqual([5]);
    expect(h.tasks.get(id)).toMatchObject({ stage: "Validating", mergeSha: MERGE });

    h.github.commits.set(MERGE, checks("success"));
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).toBe("Done");

    for (const threadId of ["t1", "t2"]) {
      expect(h.events.thread("w1", threadId)).toMatchObject({
        taskId: String(id),
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
    expect(h.tasks.get(id)).toMatchObject({ stage: "Implementing", rounds: 1 });
    expect(h.t3.sends.at(-1)).toMatchObject({ threadId: "t1" });
    expect(h.t3.sends.at(-1)?.message).toContain("handle the empty case");
    expect(h.t3.sends.at(-1)?.message).toContain('"status": "done"');

    h.github.prs.set(5, pr(5, SHA2));
    h.finish("t1", implementResult(5, SHA2));
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).toBe("Reviewing");
    h.finish("t3", reviewResult("changes", SHA2, "1. still wrong"));
    await h.pipeline.tick();
    h.github.prs.set(5, pr(5, SHA));
    h.finish("t1", implementResult(5, SHA));
    await h.pipeline.tick();
    h.finish("t4", reviewResult("changes", SHA, "1. still wrong"));
    await h.pipeline.tick();

    expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });
    expect(h.tasks.get(id).reason).toMatch(/after 2 rounds/);
  });

  it("escalates to the lead on a failed thread, a missing result, or a question", async () => {
    for (const [text, status, reason] of [
      ["", "failed", /ended failed/],
      ["All done!", "completed", /no valid result block/],
      ["", "waiting", /asked a question/],
    ] as const) {
      const h = harness();
      const id = admitted(h);
      await h.pipeline.queue(id, "brief");
      h.finish("t1", text, status);
      await h.pipeline.tick();
      expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });
      expect(h.tasks.get(id).reason).toMatch(reason);
    }
  });

  it("waits on a usage limit instead of escalating, and follows the thread when T3 resumes it", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    h.t3.states.set("t1", {
      status: "failed",
      latestRunId: "r1",
      snoozedUntil: "2026-11-25T14:00:00.000Z",
    });
    h.limit("t1");
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({ stage: "Implementing", escalatedTo: null });
    expect(h.tasks.get(id).waiting).toMatch(
      /Factory Claude reached its usage limit, which resets at 2026-11-25 14:00 UTC/,
    );

    // T3 resumes the thread itself once the limit resets, so Hephaestus sends nothing.
    h.setClock(Date.parse("2026-11-25T13:59:00Z"));
    await h.pipeline.tick();
    h.t3.states.set("t1", { status: "running", latestRunId: "r2", snoozedUntil: null });
    h.setClock(Date.parse("2026-11-25T14:06:00Z"));
    await h.pipeline.tick();
    expect(h.t3.sends).toHaveLength(0);
    expect(h.tasks.get(id).waiting).toBeNull();
    expect(h.events.thread("w1", "t1")?.status).toBe("starting");

    h.github.prs.set(5, pr(5, SHA));
    h.finish("t1", implementResult(5, SHA));
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).toBe("Reviewing");
  });

  it("continues a thread on a usage limit itself when T3 does not, and checks again on a new limit", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    // The review thread runs on Factory Codex. T3 reports no snooze, so the reset time is unknown.
    h.limit("t2");
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({ stage: "Reviewing", escalatedTo: null });
    expect(h.tasks.get(id).waiting).toMatch(/Factory Codex reached its usage limit.*30 minutes/);

    h.setClock(Date.parse("2026-11-25T12:20:00Z"));
    await h.pipeline.tick();
    expect(h.t3.sends).toHaveLength(0);
    h.setClock(Date.parse("2026-11-25T12:31:00Z"));
    await h.pipeline.tick();
    expect(h.t3.sends.map((send) => send.threadId)).toEqual(["t2"]);
    expect(h.t3.sends[0]?.message).toMatch(/usage limit/);
    // A review thread is reminded of its own result block, which a long thread may have compacted away.
    expect(h.t3.sends[0]?.message).toContain('"verdict"');
    expect(h.tasks.get(id).waiting).toBeNull();

    // The limit had not reset yet: the next run fails on it too, and the task waits again.
    h.t3.states.set("t2", { status: "failed", latestRunId: "r2", snoozedUntil: null });
    h.limit("t2", "You have hit your limit - resets 8pm");
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({ stage: "Reviewing", escalatedTo: null });
    expect(h.tasks.get(id).waiting).toMatch(/usage limit/);

    h.setClock(Date.parse("2026-11-25T13:02:00Z"));
    await h.pipeline.tick();
    expect(h.t3.sends).toHaveLength(2);
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).not.toBe("Escalated");
  });

  it("takes a limit reported as a completed reply for a usage limit too", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    h.t3.states.set("t1", { status: "completed", latestRunId: "r1", snoozedUntil: null });
    h.finish("t1", "5-hour limit reached - resets 3pm");
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({ stage: "Implementing", escalatedTo: null });
    expect(h.tasks.get(id).waiting).toMatch(/usage limit/);
    h.setClock(Date.parse("2026-11-25T12:31:00Z"));
    await h.pipeline.tick();
    expect(h.t3.sends.map((send) => send.threadId)).toEqual(["t1"]);
  });

  it("escalates a short reply about another service's rate limit", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    h.finish("t1", "Blocked: the GitHub API rate limit is hit, retry later.");
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });
  });

  it("puts a new task on the worker whose slots are free, counting held tasks", async () => {
    const h = harness((config) => {
      config.factory.limits.threadsPerWorker = 1;
    });
    h.ready.push({ environmentId: "w2", label: "w2", home: "/home/w" });
    const first = admitted(h);
    await h.pipeline.queue(first, "brief");
    expect(h.t3.launches[0]?.environmentId).toBe("w1");
    h.finish("t1", "", "failed");
    await h.pipeline.tick();
    expect(h.tasks.get(first)).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });
    const second = h.tasks.create({ repo: "octo/app", issueNumber: 5, title: "Again" }).id;
    await h.pipeline.queue(second, "brief");
    expect(h.t3.launches[1]?.environmentId).toBe("w2");
  });

  it("lets the lead restart a task while other tasks with the lead fill the cap", async () => {
    const h = harness((config) => {
      config.factory.limits.threads = 1;
    });
    const first = admitted(h);
    await h.pipeline.queue(first, "brief");
    h.finish("t1", "", "failed");
    await h.pipeline.tick();
    // Another task with the lead, which never got a thread.
    const second = h.tasks.create({ repo: "octo/app", issueNumber: 5, title: "Again" }).id;
    await h.pipeline.escalateToOwner(second, "unclear");
    await h.pipeline.sendToLead(second, "decide");
    await h.pipeline.startWork(first, "Try the other parser.");
    expect(h.t3.sends.at(-1)?.message).toContain("Try the other parser.");
  });

  it("does not continue a thread on a usage limit while the factory is paused", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    h.limit("t1");
    await h.pipeline.tick();
    h.pipeline.setPaused(true);
    h.setClock(Date.parse("2026-11-25T12:31:00Z"));
    await h.pipeline.tick();
    expect(h.t3.sends).toHaveLength(0);
    expect(h.tasks.get(id).waiting).toBe("The factory is paused.");
    h.pipeline.setPaused(false);
    // A held send is tried again a minute later.
    await h.pipeline.tick();
    expect(h.t3.sends).toHaveLength(0);
    h.setClock(Date.parse("2026-11-25T12:32:01Z"));
    await h.pipeline.tick();
    expect(h.t3.sends).toHaveLength(1);
  });

  it("reads T3 again a minute after a failed read about a usage limit, and escalates a thread T3 lost", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    h.limit("t1");
    await h.pipeline.tick();
    h.t3.stateFailures = 1;
    h.setClock(Date.parse("2026-11-25T12:31:00Z"));
    await h.pipeline.tick();
    await h.pipeline.tick();
    expect(h.t3.sends).toHaveLength(0);
    h.setClock(Date.parse("2026-11-25T12:32:01Z"));
    await h.pipeline.tick();
    expect(h.t3.sends).toHaveLength(1);

    h.limit("t1");
    await h.pipeline.tick();
    h.t3.gone.add("t1");
    h.setClock(Date.parse("2026-11-25T13:10:00Z"));
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });
    expect(h.tasks.get(id).reason).toMatch(/no longer has the thread/);
  });

  it("sends a task the lead parked on the Hermes board to the owner, with the lead's reason on the task", async () => {
    const h = harness((config) => {
      config.factory.limits.threads = 1;
    });
    const escalated = admitted(h);
    h.tasks.update(escalated, { hermesTaskId: "t_escalated" });
    await h.pipeline.queue(escalated, "brief");
    h.finish("t1", "", "failed");
    await h.pipeline.tick();
    expect(h.tasks.get(escalated)).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });
    const waiting = h.tasks.create({ repo: "octo/app", issueNumber: 5, title: "Again" }).id;
    h.tasks.update(waiting, { hermesTaskId: "t_waiting" });

    // The lead blocks both tasks with Hermes's own tool instead of calling start_work or escalate.
    h.hermes.parked.set("t_escalated", "Waiting on task 5 to merge.");
    h.hermes.parked.set("t_waiting", "The planner should clarify the issue first.");
    h.setClock(Date.parse("2026-11-25T12:30:00Z"));
    await h.pipeline.tick();

    expect(h.t3.launches).toHaveLength(1);
    for (const id of [escalated, waiting]) {
      expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", escalatedTo: "owner" });
      expect(h.tasks.get(id).reason).toMatch(/put on hold/);
    }
    // The lead's words go in the task's history; the rest can reach chat, which never names a role.
    const held = h.tasks.events(waiting).find((event) => event.kind === "held");
    expect(held?.detail).toBe("The planner should clarify the issue first.");
    const chat = [
      ...h.tasks.notifications().map((item) => item.text),
      ...[escalated, waiting].map((id) => h.tasks.get(id).reason ?? ""),
      ...h.tasks
        .events(waiting)
        .filter((event) => event.kind !== "held")
        .map((event) => event.detail),
    ];
    expect(h.tasks.notifications()).toHaveLength(2);
    for (const text of chat) expect(text).not.toMatch(/planner|lead|improver/i);
    // Neither holds a thread slot while it waits for the owner.
    const third = h.tasks.create({ repo: "octo/app", issueNumber: 5, title: "Third" }).id;
    await h.pipeline.queue(third, "brief");
    expect(h.tasks.get(third)).toMatchObject({ stage: "Implementing", waiting: null });

    // Sent back, the task is unblocked and stays with the lead. Each read runs the Hermes CLI,
    // so the board is read at most once a minute.
    await h.pipeline.sendToLead(escalated, "task 5 merged; go on");
    await h.pipeline.tick();
    expect(h.hermes.reads).toBe(2);
    h.setClock(Date.parse("2026-11-25T12:31:00Z"));
    await h.pipeline.tick();
    expect(h.hermes.reads).toBe(3);
    expect(h.tasks.get(escalated)).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });
  });

  it("takes a started task off the lead's queue on the board before any thread runs", async () => {
    // The worker has a free task slot but no free thread, so a started task waits for a thread.
    const h = harness((config) => {
      config.factory.limits.threads = 1;
      config.factory.limits.tasksPerWorker = 3;
    });
    const running = admitted(h);
    await h.pipeline.queue(running, "brief");
    expect(h.t3.launches).toHaveLength(1);
    const id = h.tasks.create({ repo: "octo/app", issueNumber: 5, title: "Next" }).id;
    h.tasks.update(id, { hermesTaskId: "t_1" });

    await h.pipeline.queue(id, "brief");

    expect(h.tasks.get(id)).toMatchObject({ stage: "Queued", implementThread: null });
    expect(h.t3.launches).toHaveLength(1);
    expect(h.board).toEqual(["t_1 Queued"]);

    // A task held before its first thread, then sent back, is restarted with no thread to resume.
    const held = h.tasks.create({ repo: "octo/app", issueNumber: 5, title: "Held" }).id;
    h.tasks.update(held, { hermesTaskId: "t_2" });
    h.hermes.parked.set("t_2", "Waiting on task 1.");
    await h.pipeline.tick();
    await h.pipeline.sendToLead(held, "go on");
    await h.pipeline.queue(held, "brief");

    expect(h.t3.launches).toHaveLength(1);
    expect(h.board.at(-1)).toBe("t_2 Queued");
  });

  it("keeps a task with the owner when the board cannot take it back for the lead", async () => {
    const h = harness();
    const id = admitted(h);
    h.tasks.update(id, { hermesTaskId: "t_1" });
    h.hermes.parked.set("t_1", "Waiting on task 5 to merge.");
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", escalatedTo: "owner" });

    h.hermes.handBackFails = true;
    await expect(h.pipeline.sendToLead(id, "go on")).rejects.toThrow(/cannot move/);

    expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", escalatedTo: "owner" });
    h.setClock(Date.parse("2026-11-25T12:05:00Z"));
    await h.pipeline.tick();
    expect(h.tasks.notifications()).toHaveLength(1);
  });

  it("parks the lead's task on the board when the lead restarts a task on its own thread", async () => {
    const h = harness();
    const id = admitted(h);
    h.tasks.update(id, { hermesTaskId: "t_lead" });
    await h.pipeline.queue(id, "brief");
    h.finish("t1", "", "failed");
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });
    h.board.length = 0;

    await h.pipeline.startWork(id, "try again");

    expect(h.t3.sends).toHaveLength(1);
    expect(h.board).toEqual(["t_lead Implementing t1"]);
  });

  it("counts tasks with the lead and tasks waiting on a usage limit apart in one message", async () => {
    const h = harness((config) => {
      config.factory.limits.threads = 2;
      config.factory.limits.threadsPerWorker = 3;
      config.factory.limits.tasksPerWorker = 3;
    });
    const limited = admitted(h);
    await h.pipeline.queue(limited, "brief");
    h.limit("t1");
    await h.pipeline.tick();
    const failed = h.tasks.create({ repo: "octo/app", issueNumber: 5, title: "Second" }).id;
    await h.pipeline.queue(failed, "brief");
    h.finish("t2", "", "failed");
    await h.pipeline.tick();
    expect(h.tasks.get(failed)).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });

    const third = h.tasks.create({ repo: "octo/app", issueNumber: 5, title: "Third" }).id;
    await h.pipeline.queue(third, "brief");

    expect(h.tasks.get(third).waiting).toBe(
      "The limit of 2 running factory threads is reached, counting 1 task with the lead and 1 waiting for a usage limit to reset.",
    );
  });

  it("keeps the thread slot of a task waiting on a usage limit or on the lead", async () => {
    const h = harness((config) => {
      config.factory.limits.threads = 1;
    });
    const first = admitted(h);
    await h.pipeline.queue(first, "brief");
    h.limit("t1");
    await h.pipeline.tick();
    const second = h.tasks.create({ repo: "octo/app", issueNumber: 5, title: "Again" }).id;
    await h.pipeline.queue(second, "brief");
    expect(h.t3.launches).toHaveLength(1);
    expect(h.tasks.get(second).waiting).toBe(
      "The limit of 1 running factory threads is reached, counting 1 task waiting for a usage limit to reset.",
    );

    // The first task's next run fails for another reason, so it goes to the lead and keeps its slot.
    h.setClock(Date.parse("2026-11-25T12:31:00Z"));
    await h.pipeline.tick();
    expect(h.t3.sends).toHaveLength(1);
    h.finish("t1", "", "failed");
    await h.pipeline.tick();
    expect(h.tasks.get(first)).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });
    expect(h.t3.launches).toHaveLength(1);
    await h.pipeline.tick();
    expect(h.tasks.get(second).waiting).toBe(
      "The limit of 1 running factory threads is reached, counting 1 task with the lead.",
    );

    // Once it is with the owner, it is blocked, and the next task may start.
    await h.pipeline.escalateToOwner(first, "needs a decision");
    await h.pipeline.tick();
    expect(h.t3.launches).toHaveLength(2);
  });

  it("does not take a review of an older head commit", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.finish("t2", reviewResult("approve", SHA2));
    await h.pipeline.tick();
    expect(h.github.merged).toEqual([]);
    expect(h.tasks.get(id).reason).toMatch(/covered/);
  });

  it("stops before merging a PR that touches an escalation path, until the owner approves that head", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.github.prs.set(5, pr(5, SHA, { files: ["src/app.ts", ".github/workflows/ci.yml"] }));
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();

    expect(h.github.merged).toEqual([]);
    expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", escalatedTo: "owner" });
    expect(h.tasks.get(id).reason).toBe(
      "the PR touches an escalation path: .github/workflows/ci.yml",
    );
    expect(h.tasks.notifications()[0]?.text).toBe(
      `Task ${String(id)} in octo/app needs you: the PR touches an escalation path: .github/workflows/ci.yml`,
    );

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
    await h.pipeline.queue(id, "brief");
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
    expect(h.tasks.get(id)).toMatchObject({ stage: "Merging", waiting: "checks are running" });

    h.github.prs.set(5, pr(5, SHA, { checks: "failure", failedChecks: ["test"] }));
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });
  });

  it("starts no thread while paused or at a cap, and says why", async () => {
    const h = harness((config) => {
      config.factory.limits.threadsPerWorker = 1;
    });
    const first = admitted(h);
    h.pipeline.setPaused(true);
    await h.pipeline.queue(first, "brief");
    expect(h.t3.launches).toHaveLength(0);
    expect(h.tasks.get(first).waiting).toBe("The factory is paused.");

    h.pipeline.setPaused(false);
    await h.pipeline.tick();
    expect(h.t3.launches).toHaveLength(1);

    const second = h.tasks.create({ repo: "octo/app", issueNumber: 5, title: "Again" }).id;
    await h.pipeline.queue(second, "brief");
    expect(h.t3.launches).toHaveLength(1);
    expect(h.tasks.get(second).waiting).toMatch(/worker's limit of 1/);
  });

  it("holds back a daily start cap and a missing worker", async () => {
    const h = harness((config) => {
      config.factory.limits.startsPerDay = 0;
    });
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    expect(h.tasks.get(id).waiting).toMatch(/per day/);

    const other = harness();
    other.ready.length = 0;
    const task = admitted(other);
    await other.pipeline.queue(task, "brief");
    expect(other.tasks.get(task).waiting).toBe("No worker is ready.");
  });

  it("reverts a merge whose checks fail, after reviewing the revert, reopens the issue, and starts again", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    h.github.commits.set(MERGE, checks("failure", ["ci"], ["ci"]));
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({ stage: "Reverting", revertPr: 9, headSha: null });
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
    expect(h.tasks.notifications()[0]?.text).toBe(
      `Reverted PR #5 in octo/app (task ${String(id)}): its merge failed checks on the default branch. The task is back in Implementing.`,
    );
    expect(h.tasks.get(id)).toMatchObject({ stage: "Implementing", prNumber: null });

    await h.pipeline.tick();
    expect(h.t3.launches.at(-1)?.message).toContain("reverted");
    expect(h.t3.launches.at(-1)?.workspace).toMatchObject({
      branch: "factory/0123abcd-task-1-retry-9",
    });
  });

  it("sends a revert PR that touches an escalation path to the owner", async () => {
    const h = harness((config) => {
      config.projects["octo/app"] = {
        policy: { preset: "yolo", overrides: { escalationPaths: ["ci/**"] } },
      };
    });
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    h.github.prs.set(5, pr(5, SHA));
    h.finish("t1", implementResult(5, SHA));
    await h.pipeline.tick();
    h.github.commits.set(MERGE, checks("failure", ["ci"], ["ci"]));
    await h.pipeline.tick();
    h.github.prs.set(9, pr(9, SHA2, { headBranch: "revert-5", files: ["ci/build.yml"] }));
    await h.pipeline.tick();

    expect(h.github.merged).toEqual([5]);
    expect(h.tasks.get(id)).toMatchObject({
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
      await h.pipeline.queue(id, "brief");
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
      expect(h.tasks.get(id)).toMatchObject({
        stage: "Escalated",
        escalatedTo: "owner",
        ownerAction: "revert-merge",
      });
      expect(h.tasks.get(id).reason).toMatch(/revert PR #9 conflicts with the default branch/);
    }
  });

  it("sends a revert PR GitHub keeps refusing to the owner as a revert merge", async () => {
    const h = harness((config) => {
      config.projects["octo/app"] = { policy: { preset: "yolo", overrides: {} } };
    });
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    h.github.prs.set(5, pr(5, SHA));
    h.finish("t1", implementResult(5, SHA));
    await h.pipeline.tick();
    h.github.commits.set(MERGE, checks("failure", ["ci"], ["ci"]));
    await h.pipeline.tick();
    const merge = h.github.merge.bind(h.github);
    h.github.merge = (repo: string, number: number, head: string) =>
      number === 9
        ? Promise.reject(new MergeRefusedError(9, 405, "Merge queue required"))
        : merge(repo, number, head);
    h.github.prs.set(9, pr(9, SHA2, { headBranch: "revert-5" }));
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).toBe("Reverting");
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({
      stage: "Escalated",
      escalatedTo: "owner",
      ownerAction: "revert-merge",
    });
    expect(h.tasks.get(id).reason).toMatch(
      /revert PR #9: Merge queue required|revert PR #9.*Merge queue required/,
    );
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
    expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", ownerAction: "revert-merge" });
  });

  it("counts a revert PR the owner merged by hand", async () => {
    const h = harness((config) => {
      config.projects["octo/app"] = {
        policy: { preset: "yolo", overrides: { escalationPaths: ["ci/**"] } },
      };
    });
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    h.github.prs.set(5, pr(5, SHA));
    h.finish("t1", implementResult(5, SHA));
    await h.pipeline.tick();
    h.github.commits.set(MERGE, checks("failure", ["ci"], ["ci"]));
    await h.pipeline.tick();
    h.github.prs.set(9, pr(9, SHA2, { headBranch: "revert-5", files: ["ci/build.yml"] }));
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).toBe("Escalated");

    // The owner merges the revert on GitHub instead of approving it on the dashboard.
    h.github.prs.set(
      9,
      pr(9, SHA2, { headBranch: "revert-5", state: "MERGED", mergeSha: "f".repeat(40) }),
    );
    h.github.reopenFailures = 1;
    h.setClock(Date.parse("2026-11-25T13:00:00Z"));
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).toBe("Reverting");
    // The issue's reopen fails once; the retry a day later keeps the revert's day and logs it once.
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).toBe("Reverting");
    h.setClock(Date.parse("2026-11-26T13:00:00Z"));
    await h.pipeline.tick();

    expect(h.github.merged).toEqual([5]);
    expect(h.tasks.revertCount()).toBe(1);
    expect(h.tasks.mergedByHephaestus("octo/app", 9)).toBe(false);
    expect(h.github.reopened).toEqual([5]);
    expect(h.tasks.get(id)).toMatchObject({ stage: "Implementing", reverting: false });
    expect(h.tasks.events(id).filter((event) => event.kind === "foreign-merge")).toHaveLength(1);
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

    expect(h.tasks.mergedByHephaestus("octo/app", 9)).toBe(true);
    expect(h.tasks.events(id).some((event) => event.kind === "foreign-merge")).toBe(false);
  });

  it("lets the owner send a retried task to the lead after its earlier revert completed", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.escalateToOwner(id, "checks failed on the retry's merge commit");
    h.tasks.update(id, { revertPr: 9, prNumber: 12, mergeSha: MERGE, reverting: false });
    h.tasks.recordMerge("octo/app", 12, MERGE, id, false);

    await h.pipeline.sendToLead(id, "look again");
    expect(h.tasks.get(id).escalatedTo).toBe("lead");
  });

  it("finishes a revert the owner merged by hand while the checks API is down", async () => {
    const h = harness((config) => {
      config.projects["octo/app"] = {
        policy: { preset: "yolo", overrides: { escalationPaths: ["ci/**"] } },
      };
    });
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    h.github.prs.set(5, pr(5, SHA));
    h.finish("t1", implementResult(5, SHA));
    await h.pipeline.tick();
    h.github.commits.set(MERGE, checks("failure", ["ci"], ["ci"]));
    await h.pipeline.tick();
    h.github.prs.set(9, pr(9, SHA2, { headBranch: "revert-5", files: ["ci/build.yml"] }));
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).toBe("Escalated");

    h.github.prs.set(
      9,
      pr(9, SHA2, { headBranch: "revert-5", state: "MERGED", mergeSha: "f".repeat(40) }),
    );
    h.github.pullRequest = () => Promise.reject(new Error("HTTP 503 from the checks API"));
    h.setClock(Date.parse("2026-11-25T13:00:00Z"));
    await h.pipeline.tick();
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({ stage: "Implementing", reverting: false });
    expect(h.github.reopened).toEqual([5]);
  });

  it("finishes a merge in flight under its last policy when its project is removed, and finds a project by any casing", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).toBe("Validating");
    delete h.config.projects["octo/app"];
    // The merge fails its checks after the project is gone: it is still reverted.
    h.github.commits.set(MERGE, checks("failure", ["ci"], ["ci"]));
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({ stage: "Reverting", revertPr: 9 });
    expect(h.github.reverted).toEqual([5]);
    await h.pipeline.tick();
    h.finish(`t${String(h.t3.launches.length)}`, reviewResult("approve", SHA2));
    await h.pipeline.tick();
    expect(h.github.merged).toEqual([5, 9]);
    expect(h.github.reopened).toEqual([5]);
    // Back in Implementing, new work waits until the project is added again.
    await h.pipeline.tick();
    expect(h.tasks.get(id).waiting).toMatch(/no longer a factory project/);

    // The project comes back under GitHub's spelling; a task recorded as Octo/App still finds it.
    const other = harness((config) => {
      config.projects = { "octo/app": { policy: { preset: "standard", overrides: {} } } };
    });
    const task = other.tasks.create({ repo: "Octo/App", issueNumber: 5, title: "Old casing" }).id;
    other.github.issues.set(5, { number: 5, title: "x", body: "", author: "x", state: "OPEN" });
    await other.pipeline.queue(task, "brief");
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
    expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", ownerAction: "merge" });
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
    expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", ownerAction: "merge" });
  });

  it("starts no new merge for a removed project, though its review approves", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    delete h.config.projects["octo/app"];
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).toBe("Reviewing");
    expect(h.tasks.get(id).waiting).toMatch(/no longer a factory project/);
    expect(h.github.merged).toEqual([]);
  });

  it("records the policy of a task already validating, so its project's removal cannot strand it", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    // As after an upgrade that added the snapshot: the task has none yet.
    h.tasks.update(id, { policy: null });
    await h.pipeline.tick();
    delete h.config.projects["octo/app"];
    h.github.commits.set(MERGE, checks("failure", ["ci"], ["ci"]));
    await h.pipeline.tick();
    expect(h.github.reverted).toEqual([5]);
  });

  it("does not take a PR from another branch, and never reverts a merge it did not make", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    h.github.prs.set(6, pr(6, SHA, { headBranch: "someone/else" }));
    h.finish("t1", implementResult(6, SHA));
    await h.pipeline.tick();
    expect(h.tasks.get(id).reason).toMatch(/not the task's branch/);

    const other = harness();
    const task = admitted(other);
    await toReview(other, task);
    other.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    other.finish("t2", reviewResult("approve", SHA));
    await other.pipeline.tick();
    expect(other.tasks.get(task)).toMatchObject({ stage: "Done", foreignMerge: true });
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
    expect(h.tasks.get(id)).toMatchObject({ stage: "Validating" });
    expect(h.tasks.get(id).waiting).toMatch(/lint/);

    h.github.commits.set(MERGE, checks("success", ["ci", "lint"]));
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).toBe("Done");
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
    expect(h.tasks.get(id).stage).toBe("Validating");
    h.setClock(Date.parse("2026-11-25T12:11:00Z"));
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).toBe("Done");

    const strict = harness();
    const task = admitted(strict);
    await toReview(strict, task);
    strict.github.prs.set(5, pr(5, SHA, { checks: "none", checkNames: [] }));
    strict.finish("t2", reviewResult("approve", SHA));
    await strict.pipeline.tick();
    expect(strict.github.merged).toEqual([]);
    strict.setClock(Date.parse("2026-11-25T13:01:00Z"));
    await strict.pipeline.tick();
    expect(strict.tasks.get(task)).toMatchObject({ stage: "Escalated", escalatedTo: "owner" });
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
      title: "Task",
      providerInstanceId: FACTORY_CLAUDE,
      model: "m",
      configVersion: 3,
      taskId: String(id),
      kind: "implement",
    });
    await h.pipeline.queue(id, "brief");
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
    expect(h.tasks.get(id).waiting).toMatch(/required checks have not run: e2e/);
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
    expect(h.tasks.get(id)).toMatchObject({ stage: "Implementing", rounds: 1, reviewThread: null });
    expect(h.t3.sends.at(-1)).toMatchObject({ threadId: "t1" });
    expect(h.t3.sends.at(-1)?.message).toContain("conflicts with `main`");
    expect(h.tasks.events(id)).toContainEqual(
      expect.objectContaining({
        kind: "stage:Implementing",
        detail: "the PR conflicts with its base branch",
      }),
    );

    h.db.prepare("UPDATE tasks SET rounds = 99, stage = 'Merging' WHERE id = ?").run(id);
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });
    expect(h.tasks.get(id).reason).toMatch(/conflicts with main after 99 rounds/);
  });

  it("retries a merge GitHub refuses once, then escalates to the owner with GitHub's message", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    let attempts = 0;
    h.github.merge = (_repo, number) => {
      attempts++;
      return Promise.reject(new MergeRefusedError(number, 405, "Head branch is not up to date"));
    };
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    expect(attempts).toBe(1);
    expect(h.tasks.get(id).stage).toBe("Merging");
    expect(h.tasks.get(id).waiting).toMatch(/Head branch is not up to date.*trying once more/);
    // A pass that finds the same refusal again does not hold the task in Merging.
    await h.pipeline.tick();
    expect(attempts).toBe(2);
    expect(h.tasks.get(id)).toMatchObject({
      stage: "Escalated",
      escalatedTo: "owner",
      ownerAction: "merge",
    });
    expect(h.tasks.get(id).reason).toMatch(/Head branch is not up to date/);
  });

  it("counts a refusal per head, so a new head gets its own retry", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.github.merge = (_repo, number) =>
      Promise.reject(new MergeRefusedError(number, 409, "Merge queue required"));
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    // An earlier head's refusal does not count against this one.
    h.tasks.event(id, "merge-refused", `${SHA2}: Merge queue required`);
    expect(h.tasks.get(id).stage).toBe("Merging");
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", escalatedTo: "owner" });
  });

  it("leaves a task in Merging when the merge fails with a network error or a server error", async () => {
    for (const failure of ["connection reset", "gh: Server Error (HTTP 502)"]) {
      const h = harness();
      const id = admitted(h);
      await toReview(h, id);
      h.github.merge = () => Promise.reject(new Error(failure));
      h.finish("t2", reviewResult("approve", SHA));
      await h.pipeline.tick();
      await h.pipeline.tick();
      await h.pipeline.tick();
      expect(h.tasks.get(id)).toMatchObject({ stage: "Merging", reason: null });
    }
  });

  it("sends a PR GitHub reports conflicting back before waiting on checks that will never run", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.github.prs.set(5, pr(5, SHA, { mergeable: "CONFLICTING", checks: "none" }));
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    expect(h.github.merged).toEqual([]);
    expect(h.tasks.get(id)).toMatchObject({ stage: "Implementing", rounds: 1 });
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
    expect(h.tasks.get(id)).toMatchObject({ stage: "Validating", foreignMerge: false });

    const other = harness();
    const task = admitted(other);
    await toReview(other, task);
    other.github.merge = () => Promise.reject(new MergeOutcomeUnknownError(5));
    other.finish("t2", reviewResult("approve", SHA));
    await other.pipeline.tick();
    expect(other.tasks.get(task)).toMatchObject({ stage: "Escalated", escalatedTo: "owner" });
    expect(other.tasks.get(task).reason).toMatch(/could not read back/);

    // The merge went through after all, with Hephaestus's marker: the scan for merges made
    // elsewhere hands it to the merge step, which validates it like any of its merges.
    other.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    other.github.ownMerges.add(MERGE);
    other.setClock(Date.parse("2026-11-25T13:00:00Z"));
    await other.pipeline.tick();
    await other.pipeline.tick();
    expect(other.tasks.get(task)).toMatchObject({ stage: "Validating", foreignMerge: false });
    expect(other.tasks.mergedByHephaestus("octo/app", 5)).toBe(true);
  });

  it("validates its own merge that a restarted implementer reports, and says when it cannot tell", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    // Hephaestus merged PR 5 on an earlier attempt, and the reply was lost.
    h.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    h.github.ownMerges.add(MERGE);
    const read = h.github.mergedWith.bind(h.github);
    h.github.mergedWith = () => Promise.resolve(undefined);
    h.finish("t1", implementResult(5, SHA));
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({
      stage: "Implementing",
      waiting: "reading back whether the merge was Hephaestus's",
    });

    h.github.mergedWith = read;
    await h.pipeline.tick();
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({ stage: "Validating", foreignMerge: false });
  });

  it("skips a task abandoned while the scan for outside merges reads another, and goes on after an error", async () => {
    const h = harness();
    // Three escalated tasks whose PRs Hephaestus merged; the scan reads them newest first.
    const ids = [5, 6, 7].map((number) => {
      const id = h.tasks.create({ repo: "octo/app", issueNumber: number, title: "Work" }).id;
      const sha = String(number).repeat(40);
      h.tasks.transition(id, "Queued", "the lead queued the work");
      h.tasks.transition(id, "Implementing", "work started", { prNumber: number, headSha: sha });
      h.tasks.transition(id, "Escalated", "to the owner: check the PR", {
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
    expect(h.tasks.get(middle).stage).toBe("Abandoned");
    expect(h.tasks.get(oldest).stage).not.toBe("Escalated");
  });

  it("marks the implementer's result handled when its own merge is found, whichever read sees the marker", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    // A restarted task still carries the PR of its earlier attempt, which the scan reads.
    h.tasks.update(id, { prNumber: 5, headSha: SHA });
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

    expect(h.tasks.get(id).stage).toBe("Validating");
    expect(h.tasks.get(id).handled.t1).toBeDefined();
  });

  it("records the PR and head of an outside merge a restarted implementer reports", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    // The task still names the PR of an earlier attempt; the implementer reports a new one,
    // which someone merged by hand.
    h.tasks.update(id, { prNumber: 4, headSha: SHA2 });
    h.github.prs.set(4, pr(4, SHA2));
    h.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    h.finish("t1", implementResult(5, SHA));
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({
      stage: "Done",
      foreignMerge: true,
      prNumber: 5,
      headSha: SHA,
    });
    expect(h.tasks.notifications()[0]?.text).toContain("PR #5 ");
  });

  it("keeps a task whose merge outcome is unknown from the lead, and validates the merge on approval", async () => {
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
    expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", ownerAction: "merge" });

    // Sending it to the lead settles the merge instead of restarting work on top of it.
    await expect(h.pipeline.sendToLead(id, "start over")).rejects.toThrow(/validate the merge/);
    expect(h.tasks.get(id).stage).toBe("Merging");
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({ stage: "Validating", foreignMerge: false });
  });

  it("settles a restart queued before GitHub reported the merge, instead of sending it", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    h.tasks.update(id, { prNumber: 5, headSha: SHA });
    h.github.prs.set(5, pr(5, SHA));
    await h.pipeline.escalateToOwner(id, "check the PR");
    await h.pipeline.sendToLead(id, "go on");
    h.pipeline.setPaused(true);
    await h.pipeline.startWork(id, "new brief");
    expect(h.tasks.get(id).pendingMessage).not.toBeNull();

    h.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    h.github.ownMerges.add(MERGE);
    const sends = h.t3.sends.length;
    h.pipeline.setPaused(false);
    await h.pipeline.tick();
    await h.pipeline.tick();
    expect(h.t3.sends).toHaveLength(sends);
    expect(h.tasks.get(id)).toMatchObject({ stage: "Validating", pendingMessage: null });
  });

  it("validates a queued restart's merge while paused, and keeps the message while unsure", async () => {
    const h = harness();
    const id = await queuedRestart(h);
    h.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    h.github.ownMerges.add(MERGE);
    const marker = h.github.mergedWith.bind(h.github);
    h.github.mergedWith = () => Promise.resolve(undefined);
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).toBe("Implementing");
    expect(h.tasks.get(id).pendingMessage).not.toBeNull();
    h.github.mergedWith = marker;
    // The scan for outside merges runs every few minutes and hands on a task waiting to send.
    h.setClock(Date.parse("2026-11-25T12:10:00Z"));
    await h.pipeline.tick();
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({ stage: "Validating", pendingMessage: null });
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
    // Past the interval of the scan that ran when the task was queued.
    h.setClock(Date.parse("2026-11-25T12:06:00Z"));
    await h.pipeline.tick();
    await h.pipeline.tick();
    await h.pipeline.tick();
    // Only the scan for outside merges reads, once in its interval; the held send reads nothing.
    expect(reads).toBe(1);
  });

  it("sends nothing on a read that went stale while another task held the launch queue", async () => {
    const h = harness();
    const id = await queuedRestart(h);
    h.tasks.transition(id, "Escalated", "to the lead: again", { escalatedTo: "lead" });
    h.pipeline.setPaused(false);
    // Another task's launch holds the launch queue until released.
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
    const other = h.tasks.create({ repo: "octo/app", issueNumber: 6, title: "Other" }).id;
    const otherStart = h.pipeline.queue(other, "brief");
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
    expect(h.tasks.get(id).stage).not.toBe("Implementing");
  });

  it("says why a queued message waits when the PR cannot be read, and sends nothing", async () => {
    const h = harness();
    const id = await queuedRestart(h);
    h.pipeline.setPaused(false);
    h.github.mergeState = () => Promise.reject(new Error("HTTP 503"));
    const sends = h.t3.sends.length;
    await h.pipeline.tick();
    expect(h.t3.sends).toHaveLength(sends);
    expect(h.tasks.get(id).waiting).toBe("reading whether the PR has merged");
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
    expect(h.tasks.get(id).pendingMessage).not.toBeNull();
  });

  it("hands on a merged task from the scan while the files and checks API is down", async () => {
    const h = harness();
    const id = await queuedRestart(h);
    h.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    h.github.pullRequest = () => Promise.reject(new Error("HTTP 503 from the checks API"));
    // Past the interval of the scan that ran when the task was queued.
    h.setClock(Date.parse("2026-11-25T12:06:00Z"));
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({ stage: "Done", foreignMerge: true });
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
    expect(h.tasks.get(id).pendingMessage).not.toBeNull();
  });

  it("restarts a task whose open PR's checks cannot be read", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    h.tasks.update(id, { prNumber: 5, headSha: SHA });
    h.github.prs.set(5, pr(5, SHA));
    await h.pipeline.escalateToOwner(id, "check the PR");
    await h.pipeline.sendToLead(id, "go on");
    // The full PR read also reads files and checks; the restart guard needs only the merge state.
    h.github.pullRequest = () => Promise.reject(new Error("HTTP 503 from the checks API"));
    expect((await h.pipeline.startWork(id, "new brief")).stage).toBe("Implementing");
  });

  it("settles an unrecorded merge when the lead restarts the task, whoever merged it", async () => {
    const h = harness();
    const ours = admitted(h);
    await h.pipeline.queue(ours, "brief");
    h.tasks.update(ours, { prNumber: 5, headSha: SHA });
    // The hand-back's read saw the PR still open; by start_work, GitHub reports the merge.
    await h.pipeline.escalateToOwner(ours, "check the PR");
    h.github.prs.set(5, pr(5, SHA));
    await h.pipeline.sendToLead(ours, "go on");
    h.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    h.github.ownMerges.add(MERGE);
    await expect(h.pipeline.startWork(ours, "new brief")).rejects.toThrow(/validate the merge/);
    expect(h.tasks.get(ours).stage).toBe("Merging");

    // Merged by hand: the owner is told the task is done, not to approve it.
    const other = harness();
    const theirs = admitted(other);
    await other.pipeline.queue(theirs, "brief");
    other.tasks.update(theirs, { prNumber: 5, headSha: SHA });
    await other.pipeline.escalateToOwner(theirs, "checks fail");
    other.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    await expect(other.pipeline.sendToLead(theirs, "fix it")).rejects.toThrow(
      /outside Hephaestus, so the task is done/,
    );
    expect(other.tasks.get(theirs)).toMatchObject({ stage: "Done", foreignMerge: true });
  });

  it("settles a task's threads once it is done, and keeps those of an active or escalated task", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    // The implement thread has ended, but the task is still in review.
    await h.pipeline.tick();
    await h.pipeline.settleThreads();
    expect(h.t3.settled).toEqual([]);

    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    h.github.commits.set(MERGE, checks("success", ["ci"]));
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).toBe("Done");
    await h.pipeline.settleThreads();
    expect(h.t3.settled.sort()).toEqual(["t1", "t2"]);
    // Each thread is settled once.
    await h.pipeline.settleThreads();
    expect(h.t3.settled).toHaveLength(2);

    const other = harness();
    const task = admitted(other);
    await other.pipeline.queue(task, "brief");
    other.finish("t1", "no result block");
    await other.pipeline.tick();
    expect(other.tasks.get(task).stage).toBe("Escalated");
    await other.pipeline.settleThreads();
    expect(other.t3.settled).toEqual([]);
  });

  it("settles a replaced thread and a finished setup thread", async () => {
    const h = harness();
    const id = admitted(h);
    await toReview(h, id);
    h.finish("t2", reviewResult("changes", SHA));
    // A newer review thread replaces the finished one.
    h.tasks.update(id, { reviewThread: "t9" });
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
    await h.pipeline.queue(id, "brief");
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

  it("does not settle a thread a task picked up again during the pass", async () => {
    const h = harness();
    setupThread(h, "old-1");
    setupThread(h, "old-2");
    const id = h.tasks.create({ repo: "octo/app", issueNumber: 5, title: "Work" }).id;
    h.tasks.transition(id, "Queued", "the lead queued the work");
    h.tasks.transition(id, "Implementing", "work started");
    const settle = h.t3.settle.bind(h.t3);
    h.t3.settle = (environmentId, threadId) => {
      // While the first call is out, the task takes up the second thread.
      if (threadId === "old-1") h.tasks.update(id, { implementThread: "old-2" });
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

  it("does not abandon a task that started work", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    expect((await h.pipeline.abandonUnstarted(id, "the issue was closed")).stage).toBe(
      "Implementing",
    );
  });

  it("refuses a send-to-lead or abandon from a form opened before the task changed", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.escalateToOwner(id, "first question");
    // The clock stands still: both escalations share a timestamp, and only the version tells them apart.
    const seen = String(h.tasks.get(id).version);
    await h.pipeline.sendToLead(id, "answer", seen);
    await h.pipeline.escalateToOwner(id, "second question");

    await expect(h.pipeline.sendToLead(id, "late answer", seen)).rejects.toThrow(/changed/);
    await expect(h.pipeline.abandon(id, "late abandon", seen)).rejects.toThrow(/changed/);
    expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", reason: "second question" });
  });

  it("refuses a stale send-to-lead and an approval for another action", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.escalateToOwner(id, "needs a decision");
    await h.pipeline.sendToLead(id, "first note");
    await expect(h.pipeline.sendToLead(id, "second note")).rejects.toThrow(
      /not waiting for the owner/,
    );
    expect(h.tasks.get(id).reason).toBe("first note");

    const other = harness();
    const task = admitted(other);
    await toReview(other, task);
    other.github.prs.set(5, pr(5, SHA, { files: [".github/workflows/ci.yml"] }));
    other.finish("t2", reviewResult("approve", SHA));
    await other.pipeline.tick();
    await expect(other.pipeline.approveMerge(task, SHA, "revert-merge")).rejects.toThrow();
    expect((await other.pipeline.approveMerge(task, SHA, "merge")).stage).toBe("Merging");
  });

  it("does not start work for a repo that left the factory projects", async () => {
    const h = harness();
    const id = admitted(h);
    delete h.config.projects["octo/app"];
    await h.pipeline.queue(id, "brief");
    expect(h.t3.launches).toHaveLength(0);
    expect(h.tasks.get(id).waiting).toMatch(/no longer a factory project/);
  });

  it("lets a thread waiting on the lead resume within a cap of one", async () => {
    const h = harness((config) => {
      config.factory.limits.threadsPerWorker = 1;
      config.factory.limits.threads = 1;
    });
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    h.finish("t1", "", "waiting");
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).toBe("Escalated");
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
    expect(h.tasks.get(id).foreignMerge).toBe(true);
    expect(h.tasks.notifications()[0]?.text).toBe(
      `PR #5 in octo/app (task ${String(id)}) was merged outside Hephaestus.`,
    );
  });

  it("lets the lead restart an escalated task in its implement thread", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    h.finish("t1", "stuck", "completed");
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).toBe("Escalated");

    await h.pipeline.startWork(id, "Try the other parser.");
    expect(h.tasks.get(id).stage).toBe("Implementing");
    expect(h.t3.sends.at(-1)?.message).toContain("Try the other parser.");
  });

  it("refuses start_work on a task that is with the owner", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.escalateToOwner(id, "needs a product decision");
    await expect(h.pipeline.startWork(id, "brief")).rejects.toThrow(/with the owner/);
  });
});

/** Takes a task through a failed merge to its revert PR 9, whose review thread hits a usage limit. */
async function revertReviewOnLimit(h: Harness): Promise<{ id: number; review: string }> {
  const id = admitted(h);
  await toReview(h, id);
  h.finish("t2", reviewResult("approve", SHA));
  await h.pipeline.tick();
  h.github.commits.set(MERGE, checks("failure", ["ci"], ["ci"]));
  await h.pipeline.tick();
  await h.pipeline.tick();
  const review = `t${String(h.t3.launches.length)}`;
  expect(h.tasks.get(id)).toMatchObject({ stage: "Reverting", reviewThread: review });
  h.limit(review);
  await h.pipeline.tick();
  expect(h.tasks.get(id).limitUntil).not.toBeNull();
  return { id, review };
}

describe("Pipeline usage-limit waits", () => {
  it("keeps a limited thread's slot from an older queued task before the limit is classified", async () => {
    const h = harness((config) => {
      config.factory.limits.threads = 1;
    });
    const older = admitted(h);
    const limited = h.tasks.create({ repo: "octo/app", issueNumber: 5, title: "Again" }).id;
    await h.pipeline.queue(limited, "brief");
    await h.pipeline.queue(older, "brief");
    expect(h.t3.launches).toHaveLength(1);
    // The follower records the thread as failed before the next pass reads its result.
    h.limit("t1");
    await h.pipeline.tick();
    expect(h.tasks.get(limited).limitUntil).not.toBeNull();
    expect(h.t3.launches).toHaveLength(1);
    expect(h.tasks.get(older).waiting).toMatch(/limit of 1 running factory threads/);
  });

  it("follows a thread T3 resumed and finished after the read about its usage limit failed", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    h.t3.stateFailures = 1;
    h.limit("t1", undefined, "r1");
    await h.pipeline.tick();
    expect(h.tasks.get(id).limitUntil).not.toBeNull();
    // T3 resumes the thread once the limit resets, and the resumed run ends before the next check.
    h.t3.states.set("t1", { status: "completed", latestRunId: "r2", snoozedUntil: null });
    h.setClock(Date.parse("2026-11-25T12:31:00Z"));
    await h.pipeline.tick();
    expect(h.t3.sends).toHaveLength(0);
    expect(h.events.thread("w1", "t1")?.status).toBe("starting");
  });

  it("follows a thread T3 had already resumed when the pipeline first read it", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    h.t3.states.set("t1", { status: "running", latestRunId: "r2", snoozedUntil: null });
    h.limit("t1", undefined, "r1");
    await h.pipeline.tick();
    h.t3.states.set("t1", { status: "completed", latestRunId: "r2", snoozedUntil: null });
    h.setClock(Date.parse("2026-11-25T12:31:00Z"));
    await h.pipeline.tick();
    expect(h.t3.sends).toHaveLength(0);
    expect(h.events.thread("w1", "t1")?.status).toBe("starting");
  });

  it("does not continue a thread T3 resumed while the continue waited in the launch queue", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    h.limit("t1", undefined, "r1");
    await h.pipeline.tick();
    h.setClock(Date.parse("2026-11-25T12:31:00Z"));
    // Another task's restart holds the launch queue while it reads whether its PR merged.
    const other = h.tasks.create({ repo: "octo/app", issueNumber: 6, title: "Again" }).id;
    h.tasks.transition(other, "Escalated", "to the lead: try again", {
      escalatedTo: "lead",
      implementThread: "t-other",
      workerEnv: "w1",
      startedAt: "2026-11-25T12:00:00Z",
      prNumber: 7,
    });
    h.github.prs.set(7, pr(7, SHA2));
    let release = (): void => undefined;
    let reads = 0;
    const state = h.github.mergeState.bind(h.github);
    h.github.mergeState = async (repo, number) => {
      // The restart reads once before it moves the task, then again inside the launch queue.
      if (number === 7 && ++reads === 2) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return state(repo, number);
    };
    const starting = h.pipeline.startWork(other, "brief");
    await new Promise((resolve) => setImmediate(resolve));
    const passing = h.pipeline.tick();
    await new Promise((resolve) => setImmediate(resolve));
    h.t3.states.set("t1", { status: "running", latestRunId: "r2", snoozedUntil: null });
    release();
    await starting;
    await passing;
    expect(h.t3.sends.filter((send) => send.threadId === "t1")).toHaveLength(0);
    expect(h.tasks.get(id)).toMatchObject({ limitUntil: null, stage: "Implementing" });
  });

  it("hands the lead a run cancelled before any output after a usage limit", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    h.limit("t1", undefined, "r1");
    await h.pipeline.tick();
    h.setClock(Date.parse("2026-11-25T12:31:00Z"));
    await h.pipeline.tick();
    expect(h.t3.sends).toHaveLength(1);
    // The continue starts run r2, which is cancelled before it writes output or an error.
    h.events.upsertItems("w1", "t1", [
      {
        itemId: "user-r2",
        position: 100,
        type: "user_message",
        status: "completed",
        text: "Continue the work.",
        runId: "r2",
      },
    ]);
    h.events.setStatus("w1", "t1", "cancelled");
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });
    expect(h.tasks.get(id).reason).toMatch(/ended cancelled/);
  });

  it("hands the lead a resumed run T3 reports cancelled before it wrote any item", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");
    h.limit("t1", undefined, "r1");
    await h.pipeline.tick();
    h.setClock(Date.parse("2026-11-25T12:31:00Z"));
    await h.pipeline.tick();
    expect(h.t3.sends).toHaveLength(1);
    // Run r2 ends cancelled, and T3's activity page has no item of its own.
    h.events.setStatusIf("w1", "t1", "starting", "cancelled", "r2");
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });
  });

  it("sends no continue when the factory is paused, or T3 snoozes the thread, while T3 is read", async () => {
    for (const change of ["pause", "snooze"] as const) {
      const h = harness();
      const id = admitted(h);
      await h.pipeline.queue(id, "brief");
      h.limit("t1", undefined, "r1");
      await h.pipeline.tick();
      h.setClock(Date.parse("2026-11-25T12:31:00Z"));
      const read = h.t3.threadState.bind(h.t3);
      let reads = 0;
      h.t3.threadState = (environmentId: string, threadId: string) => {
        reads += 1;
        // The second read is the one right before the send.
        if (reads === 2 && change === "pause") h.pipeline.setPaused(true);
        if (reads === 2 && change === "snooze") {
          h.t3.states.set(threadId, {
            status: "failed",
            latestRunId: "r1",
            snoozedUntil: "2026-11-25T13:00:00Z",
          });
        }
        return read(environmentId, threadId);
      };

      await h.pipeline.tick();

      expect(h.t3.sends).toHaveLength(0);
      if (change === "snooze") {
        expect(h.tasks.get(id).limitUntil).toBe("2026-11-25T13:05:00.000Z");
      }
    }
  });

  it("waits on Codex's retry error and a bare 429, and escalates GitHub's rate limit", async () => {
    const cases = [
      ["error", "exceeded retry limit, last status: 429 Too Many Requests", "wait"],
      ["error", "429 Too Many Requests", "wait"],
      ["error", "GitHub API rate limit reached", "escalate"],
      ["reply", "GitHub API rate limit reached", "escalate"],
    ] as const;
    for (const [end, text, outcome] of cases) {
      const h = harness();
      const id = admitted(h);
      await h.pipeline.queue(id, "brief");
      if (end === "error") h.limit("t1", text);
      else h.finish("t1", text);
      await h.pipeline.tick();
      const task = h.tasks.get(id);
      if (outcome === "wait") {
        expect(task, text).toMatchObject({ stage: "Implementing" });
        expect(task.limitUntil, text).not.toBeNull();
      } else {
        expect(task, `${end}: ${text}`).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });
      }
    }
  });

  it("escalates another service's rate limit that resets, as a thread error or a reply", async () => {
    for (const end of ["error", "reply"] as const) {
      const h = harness();
      const id = admitted(h);
      await h.pipeline.queue(id, "brief");
      const text = "Blocked: GitHub API rate limit resets at 3 PM.";
      if (end === "error") h.limit("t1", text);
      else h.finish("t1", text);
      await h.pipeline.tick();
      expect(h.tasks.get(id), end).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });
    }
  });

  it("starts the retry of a revert the owner merged while its review waited on a usage limit", async () => {
    const h = harness((config) => {
      config.factory.limits.threads = 1;
    });
    const { id } = await revertReviewOnLimit(h);
    h.github.prs.set(
      9,
      pr(9, SHA2, { headBranch: "revert-5", state: "MERGED", mergeSha: "f".repeat(40) }),
    );
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).toBe("Implementing");
    const launched = h.t3.launches.length;
    await h.pipeline.tick();
    expect(h.t3.launches).toHaveLength(launched + 1);
    expect(h.t3.launches.at(-1)?.message).toContain("reverted");
  });

  it("reviews a revert PR's new head while the review of its old head waited on a usage limit", async () => {
    const h = harness((config) => {
      config.factory.limits.threads = 1;
    });
    const { id, review } = await revertReviewOnLimit(h);
    const sha3 = "3".repeat(40);
    h.github.prs.set(9, pr(9, sha3, { headBranch: "revert-5" }));
    const launched = h.t3.launches.length;
    await h.pipeline.tick();
    expect(h.t3.launches).toHaveLength(launched + 1);
    expect(h.t3.launches.at(-1)?.message).toContain(sha3);
    expect(h.tasks.get(id)).toMatchObject({ limitUntil: null });
    expect(h.tasks.get(id).reviewThread).not.toBe(review);
  });
});

describe("Pipeline task limit", () => {
  /** A harness whose worker takes one task at a time, with thread limits that never bind. */
  function oneTask(): Harness {
    return harness((config) => {
      config.factory.limits.tasksPerWorker = 1;
      config.factory.limits.threadsPerWorker = 4;
      config.factory.limits.threads = 4;
    });
  }

  function another(h: Harness, title: string): number {
    return h.tasks.create({ repo: "octo/app", issueNumber: 5, title }).id;
  }

  it("keeps a queued task queued while its worker has a task in progress without a thread", async () => {
    const h = oneTask();
    const first = admitted(h);
    await toReview(h, first);
    h.finish("t2", reviewResult("approve", SHA));
    await h.pipeline.tick();
    expect(h.tasks.get(first).stage).toBe("Validating");
    const second = another(h, "Second");

    await h.pipeline.queue(second, "brief two");

    expect(h.tasks.get(second)).toMatchObject({
      stage: "Queued",
      brief: "brief two",
      waiting: "The limit of 1 task in progress per worker is reached.",
    });
    expect(h.t3.launches).toHaveLength(2);
  });

  it("counts a task with the lead, frees the slot of a task with the owner, and then starts the queued task", async () => {
    const h = oneTask();
    const first = admitted(h);
    await h.pipeline.queue(first, "brief");
    h.finish("t1", "", "failed");
    await h.pipeline.tick();
    expect(h.tasks.get(first)).toMatchObject({ stage: "Escalated", escalatedTo: "lead" });
    const second = another(h, "Second");
    await h.pipeline.queue(second, "brief two");
    await h.pipeline.tick();
    expect(h.tasks.get(second).stage).toBe("Queued");

    await h.pipeline.escalateToOwner(first, "needs a decision");
    await h.pipeline.tick();

    expect(h.tasks.get(second)).toMatchObject({ stage: "Implementing", waiting: null });
    expect(h.t3.launches.at(-1)?.message).toContain("brief two");
  });

  it("starts the task ahead in the queue when a task slot frees", async () => {
    const h = oneTask();
    const first = admitted(h);
    await h.pipeline.queue(first, "brief");
    const older = another(h, "Older");
    const newer = another(h, "Newer");
    await h.pipeline.queue(older, "older brief");
    await h.pipeline.escalateToOwner(first, "needs a decision");

    await h.pipeline.queue(newer, "newer brief");

    expect(h.tasks.get(older).stage).toBe("Implementing");
    expect(h.tasks.get(newer)).toMatchObject({
      stage: "Queued",
      waiting: "The limit of 1 task in progress per worker is reached.",
    });
  });

  it("holds no task slot for a queued task whose thread has not launched", async () => {
    const h = harness((config) => {
      config.factory.limits.tasksPerWorker = 1;
      config.factory.limits.threads = 0;
    });
    const first = admitted(h);
    await h.pipeline.queue(first, "brief");
    expect(h.tasks.get(first)).toMatchObject({ stage: "Queued", workerEnv: null });
    expect(h.t3.launches).toHaveLength(0);
    const second = another(h, "Second");

    await h.pipeline.queue(second, "brief two");

    expect(h.tasks.get(second)).toMatchObject({
      stage: "Queued",
      waiting: "The limit of 0 running factory threads is reached.",
    });
  });

  it("puts a started task on the worker with room for both a task and a thread", async () => {
    const h = harness((config) => {
      config.factory.limits.tasksPerWorker = 3;
      config.factory.limits.threadsPerWorker = 1;
    });
    h.ready.push({ environmentId: "w2", label: "w2", home: "/home/w2" });
    // w1 has fewer tasks, but its task with the lead holds its one thread slot; w2 has two
    // tasks verifying, which hold no thread.
    const place = (title: string, stage: string, env: string): void => {
      const id = another(h, title);
      h.db
        .prepare("UPDATE tasks SET stage = ?, worker_env = ?, escalated_to = ? WHERE id = ?")
        .run(stage, env, stage === "Escalated" ? "lead" : null, id);
    };
    place("With the lead", "Escalated", "w1");
    place("Verifying", "Validating", "w2");
    place("Verifying too", "Validating", "w2");
    const task = admitted(h);

    await h.pipeline.queue(task, "brief");

    expect(h.tasks.get(task).workerEnv).toBe("w2");
    expect(h.t3.launches.at(-1)?.environmentId).toBe("w2");
  });

  it("moves a task whose worker went away before its first launch", async () => {
    const h = harness((config) => {
      config.factory.limits.threads = 0;
    });
    const task = admitted(h);
    await h.pipeline.queue(task, "brief");
    expect(h.tasks.get(task).workerEnv).toBeNull();
    h.ready.splice(0, 1, { environmentId: "w2", label: "w2", home: "/home/w2" });
    h.config.factory.limits.threads = 4;

    await h.pipeline.tick();

    expect(h.tasks.get(task).workerEnv).toBe("w2");
    expect(h.t3.launches.at(-1)?.environmentId).toBe("w2");
  });

  it("launches a task with no worker yet only on a worker with a free task slot", async () => {
    const h = oneTask();
    const first = admitted(h);
    await h.pipeline.queue(first, "brief");
    // A task started before workers were assigned at start.
    const legacy = another(h, "Legacy");
    h.tasks.transition(legacy, "Queued", "the lead queued the work");
    h.tasks.transition(legacy, "Implementing", "test", { brief: "old brief" });

    await h.pipeline.tick();

    expect(h.t3.launches).toHaveLength(1);
    expect(h.tasks.get(legacy)).toMatchObject({
      workerEnv: null,
      waiting: "The limit of 1 task in progress per worker is reached.",
    });
  });

  it("frees the slot of a task whose project was removed, and skips its queued tasks", async () => {
    const h = oneTask();
    const first = admitted(h);
    await h.pipeline.queue(first, "brief");
    const removed = h.tasks.create({ repo: "octo/gone", issueNumber: 5, title: "Gone" }).id;
    await h.pipeline.queue(removed, "brief gone");
    const next = another(h, "Next");
    await h.pipeline.queue(next, "brief next");
    // The task of a repo that is not a factory project holds no place ahead of it.
    expect(h.tasks.get(next).waiting).toBe(
      "The limit of 1 task in progress per worker is reached.",
    );

    delete h.config.projects["octo/app"];
    h.config.projects["octo/other"] = { policy: { preset: "standard", overrides: {} } };
    h.tasks.update(next, { repo: "octo/other" });
    await h.pipeline.tick();

    expect(h.tasks.get(next).stage).toBe("Implementing");
  });

  it("starts queued tasks in the order the lead queued them", async () => {
    const h = oneTask();
    const first = admitted(h);
    await h.pipeline.queue(first, "brief");
    const created = another(h, "Created first");
    const asked = another(h, "Asked first");
    await h.pipeline.queue(asked, "asked brief");
    h.setClock(Date.parse("2026-11-25T12:05:00Z"));
    await h.pipeline.queue(created, "created brief");
    expect(h.tasks.get(created).waiting).toBe(
      "The limit of 1 task in progress per worker is reached.",
    );

    await h.pipeline.escalateToOwner(first, "needs a decision");
    await h.pipeline.tick();

    expect(h.tasks.get(asked).stage).toBe("Implementing");
    expect(h.tasks.get(created).stage).toBe("Queued");
  });

  it("leaves a queued task unchanged on a pass that cannot start it", async () => {
    const h = oneTask();
    const first = admitted(h);
    await h.pipeline.queue(first, "brief");
    const queued = another(h, "Queued");
    await h.pipeline.queue(queued, "brief two");
    expect(h.tasks.get(queued).stage).toBe("Queued");
    const version = h.tasks.get(queued).version;

    await h.pipeline.tick();
    await h.pipeline.tick();

    expect(h.tasks.get(queued).version).toBe(version);
  });

  it("keeps a task on its worker once a launch for it was sent", async () => {
    const h = harness((config) => {
      config.factory.limits.threads = 0;
    });
    const task = admitted(h);
    await h.pipeline.queue(task, "brief");
    // A launch T3 answered, recorded before the process stopped and the task got its thread.
    h.db
      .prepare(
        `INSERT INTO factory_launches (client_request_id, environment_id, title, provider_instance_id,
           model, config_version, task_id, status, thread_id, kind, created_at, updated_at)
         VALUES ('r', 'w1', 't', 'p', 'm', 1, ?, 'launched', 't9', 'implement', 'x', 'x')`,
      )
      .run(String(task));
    h.ready.splice(0, 1, { environmentId: "w2", label: "w2", home: "/home/w2" });
    h.config.factory.limits.threads = 4;

    await h.pipeline.tick();

    // The task takes up the thread that launch started, on the worker that started it.
    expect(h.tasks.get(task)).toMatchObject({
      stage: "Implementing",
      workerEnv: "w1",
      implementThread: "t9",
    });
    expect(h.t3.launches).toHaveLength(0);
  });

  it("records the worker of a task with none before its launch is sent", async () => {
    const h = oneTask();
    const legacy = admitted(h);
    h.tasks.transition(legacy, "Queued", "the lead queued the work");
    h.tasks.transition(legacy, "Implementing", "test", { brief: "old brief" });
    const launch = h.t3.launchThread.bind(h.t3);
    let workerAtLaunch: string | null | undefined;
    h.t3.launchThread = (options: LaunchOptions) => {
      workerAtLaunch = h.tasks.get(legacy).workerEnv;
      return launch(options);
    };

    await h.pipeline.tick();

    expect(workerAtLaunch).toBe("w1");
  });
});
