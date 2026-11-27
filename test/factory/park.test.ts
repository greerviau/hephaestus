import { describe, expect, it } from "vitest";
import type { PullRequest } from "../../src/factory/github.js";
import {
  SHA,
  checks,
  harness,
  implementResult,
  pr,
  reviewResult,
  type Harness,
} from "./harness.js";

const NOON = Date.parse("2026-11-25T12:00:00Z");
const HOUR = 3_600_000;

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

/** A task whose engineer asked a question, which went to the owner with PR 5 open on its branch. */
async function askedOwner(h: Harness): Promise<number> {
  const id = admitted(h);
  await h.pipeline.queue(id, "Add the flag to the CLI.");
  h.github.prs.set(5, pr(5, SHA));
  h.tasks.update(id, { prNumber: 5, headSha: SHA });
  h.finish("t1", "", "waiting");
  await h.pipeline.tick();
  await h.pipeline.escalateToOwner(id, "Should the flag be on by default?");
  return id;
}

/** A task whose PR the review approved, at the merge gate, with the PR changed by `fields` first. */
async function reviewed(h: Harness, fields: Partial<PullRequest> = {}): Promise<number> {
  const id = admitted(h);
  await h.pipeline.queue(id, "brief");
  h.github.prs.set(5, pr(5, SHA));
  h.finish("t1", implementResult(5, SHA));
  await h.pipeline.tick();
  h.github.commits.set(SHA, checks("success", ["ci"]));
  h.github.prs.set(5, pr(5, SHA, fields));
  h.finish("t2", reviewResult("approve", SHA));
  await h.pipeline.tick();
  return id;
}

/** A task held before any work started, which went to the owner with a question. */
async function askedBeforeWork(h: Harness, brief: string | null): Promise<number> {
  const id = admitted(h);
  if (brief !== null) h.tasks.update(id, { brief });
  await h.pipeline.escalateToOwner(id, "Which command takes the flag?");
  return id;
}

describe("Parking a task", () => {
  it("parks a task that waits on the owner's answer, with a re-alert a day later by default", async () => {
    const h = harness();
    const id = await askedOwner(h);

    const parked = await h.pipeline.park(id, {});

    expect(parked).toMatchObject({
      stage: "Parked",
      escalatedTo: "owner",
      reason: "Should the flag be on by default?",
      deferUntil: new Date(NOON + 24 * HOUR).toISOString(),
    });
  });

  it("parks for the time the owner gives, with their note", async () => {
    const h = harness();
    const id = await askedOwner(h);

    const parked = await h.pipeline.park(id, { hours: 4, note: "Asking the team first." });

    expect(parked.deferUntil).toBe(new Date(NOON + 4 * HOUR).toISOString());
    expect(parked.deferReason).toBe("Asking the team first.");
  });

  it("refuses a re-alert time outside one hour to thirty days", async () => {
    const h = harness();
    const id = await askedOwner(h);

    await expect(h.pipeline.park(id, { hours: 0 })).rejects.toThrow(/1 to 720 hours/);
    await expect(h.pipeline.park(id, { hours: 721 })).rejects.toThrow(/1 to 720 hours/);
    expect(h.tasks.get(id).stage).toBe("Escalated");
  });

  it("refuses to park a task that waits for the owner to approve a merge", async () => {
    const h = harness();
    h.config.projects["octo/app"] = { policy: { preset: "strict", overrides: {} } };
    const id = await reviewed(h);
    expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", ownerAction: "merge" });

    await expect(h.pipeline.park(id, {})).rejects.toThrow(
      /cannot be parked: it waits for you to approve a merge/,
    );
    expect(h.tasks.get(id).stage).toBe("Escalated");
  });

  it("refuses to park a task escalated for anything but a question, such as a PR from a fork", async () => {
    const h = harness();
    const id = await reviewed(h, { fromFork: true });
    expect(h.tasks.get(id)).toMatchObject({ stage: "Escalated", escalatedTo: "owner" });
    expect(h.tasks.get(id).reason).toMatch(/another repository/);

    await expect(h.pipeline.park(id, {})).rejects.toThrow(
      /cannot be parked: only a task that waits on your answer/,
    );
    expect(h.tasks.get(id).stage).toBe("Escalated");
  });

  it("refuses to park a task that is not waiting for the owner", async () => {
    const h = harness();
    const id = admitted(h);
    await h.pipeline.queue(id, "brief");

    await expect(h.pipeline.park(id, {})).rejects.toThrow(/is Implementing; only a task/);
  });

  it("keeps the branch, PR, and threads of a parked task, and closes nothing", async () => {
    const h = harness();
    const id = await askedOwner(h);
    const before = h.tasks.get(id);

    const parked = await h.pipeline.park(id, {});

    expect(parked).toMatchObject({
      branch: before.branch,
      prNumber: 5,
      headSha: SHA,
      implementThread: "t1",
    });
    expect(before.branch).not.toBeNull();
    expect(h.github.prs.get(5)?.state).toBe("OPEN");
    expect(h.tasks.activeThreadIds().has("t1")).toBe(true);
  });

  it("releases the worker of a parked task that never started a thread", async () => {
    const h = harness();
    const id = await askedBeforeWork(h, null);
    h.tasks.update(id, { workerEnv: "w1" });

    expect((await h.pipeline.park(id, {})).workerEnv).toBeNull();
  });

  it("keeps the worker of a parked task whose thread lives there", async () => {
    const h = harness();
    const id = await askedOwner(h);
    // As for a task from before launches were recorded: only the thread says where it runs.
    h.db.prepare("DELETE FROM factory_launches").run();

    expect((await h.pipeline.park(id, {})).workerEnv).toBe("w1");
  });

  it("frees the task slot and the thread slot of a parked task for other work", async () => {
    const h = harness((config) => {
      config.factory.limits.tasksPerWorker = 1;
      config.factory.limits.threadsPerWorker = 1;
      config.factory.limits.threads = 1;
    });
    const id = await askedOwner(h);
    await h.pipeline.park(id, {});

    const next = h.tasks.create({ repo: "octo/app", issueNumber: 6, title: "Other" }).id;
    h.github.issues.set(6, {
      number: 6,
      title: "Other",
      body: "",
      author: "owner",
      state: "OPEN",
    });
    await h.pipeline.queue(next, "brief");

    expect(h.tasks.get(next).stage).toBe("Implementing");
    expect(h.pipeline.blockedBecause("w1")).toMatch(/limit of 1/);
  });

  it("counts a parked task apart from escalated ones", async () => {
    const h = harness();
    const id = await askedOwner(h);
    await h.pipeline.park(id, {});

    expect(h.tasks.list(["Escalated"])).toHaveLength(0);
    expect(h.tasks.list(["Parked"]).map((task) => task.id)).toEqual([id]);
  });

  it("lets the owner abandon a parked task", async () => {
    const h = harness();
    const id = await askedOwner(h);
    await h.pipeline.park(id, {});

    const abandoned = await h.pipeline.abandon(id, "The owner abandoned it: not needed");

    expect(abandoned.stage).toBe("Abandoned");
    expect(h.github.prs.get(5)?.state).toBe("OPEN");
  });
});

describe("Re-alerting a parked task", () => {
  it("waits until the re-alert time, then hands the task back to the owner with its reason", async () => {
    const h = harness();
    const id = await askedOwner(h);
    await h.pipeline.park(id, { hours: 2 });
    const before = h.tasks.notifications().length;

    h.setClock(NOON + 2 * HOUR - 1);
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).toBe("Parked");

    h.setClock(NOON + 2 * HOUR);
    await h.pipeline.tick();
    expect(h.tasks.get(id)).toMatchObject({
      stage: "Escalated",
      escalatedTo: "owner",
      reason: "Should the flag be on by default?",
      deferUntil: null,
      deferReason: null,
    });
    const alerts = h.tasks.notifications();
    expect(alerts).toHaveLength(before + 1);
    expect(alerts[0]).toMatchObject({
      taskId: id,
      kind: "escalation",
      text: `Task ${String(id)} in octo/app needs you: Should the flag be on by default?`,
    });
    expect(h.tasks.events(id).at(-1)).toMatchObject({
      kind: "stage:Escalated",
      detail: "to the owner: Should the flag be on by default?",
    });
  });

  it("re-alerts after a restart, since the time is kept in the store", async () => {
    const h = harness();
    const id = await askedOwner(h);
    await h.pipeline.park(id, { hours: 1 });

    const restarted = h.restart();
    h.setClock(NOON + HOUR);
    await restarted.tick();

    expect(h.tasks.get(id).stage).toBe("Escalated");
  });

  it("can be parked again once it is back with the owner", async () => {
    const h = harness();
    const id = await askedOwner(h);
    await h.pipeline.park(id, { hours: 1 });
    h.setClock(NOON + HOUR);
    await h.pipeline.tick();

    expect((await h.pipeline.park(id, { hours: 1 })).stage).toBe("Parked");
  });

  it("does nothing for a task unparked or abandoned before its time", async () => {
    const h = harness();
    const resumed = await askedOwner(h);
    await h.pipeline.park(resumed, { hours: 1 });
    await h.pipeline.unpark(resumed, "Off by default.");
    const dropped = await askedBeforeWork(h, null);
    await h.pipeline.park(dropped, { hours: 1 });
    await h.pipeline.abandon(dropped, "not needed");
    const before = h.tasks.notifications().length;

    h.setClock(NOON + HOUR);
    await h.pipeline.tick();

    expect(h.tasks.get(resumed).stage).toBe("Implementing");
    expect(h.tasks.get(dropped).stage).toBe("Abandoned");
    expect(h.tasks.notifications()).toHaveLength(before);
  });
});

describe("Unparking a task", () => {
  it("continues work already started in its own thread, with the owner's answer and the PR kept", async () => {
    const h = harness();
    const id = await askedOwner(h);
    await h.pipeline.park(id, {});
    const launches = h.t3.launches.length;

    const resumed = await h.pipeline.unpark(id, "Off by default.");

    expect(resumed).toMatchObject({
      stage: "Implementing",
      implementThread: "t1",
      prNumber: 5,
      escalatedTo: null,
      deferUntil: null,
      pendingMessage: null,
    });
    expect(h.t3.launches).toHaveLength(launches);
    expect(h.t3.sends.at(-1)).toMatchObject({ threadId: "t1" });
    expect(h.t3.sends.at(-1)?.message).toContain("Off by default.");
    expect(h.t3.sends.at(-1)?.message).toContain("hephaestus-result");
  });

  it("starts no second worker when the owner unparks twice", async () => {
    const h = harness();
    const id = await askedOwner(h);
    await h.pipeline.park(id, {});

    await h.pipeline.unpark(id, "Off by default.");
    await expect(h.pipeline.unpark(id, "Off by default.")).rejects.toThrow(/is not parked/);

    expect(h.t3.sends).toHaveLength(1);
    expect(h.t3.launches).toHaveLength(1);
  });

  it("requeues a task whose work never started as new, with its brief and the owner's answer", async () => {
    const h = harness();
    const id = await askedBeforeWork(h, "Add the flag.");
    await h.pipeline.park(id, {});
    h.pipeline.setPaused(true);

    const requeued = await h.pipeline.unpark(id, "The build command.");

    expect(requeued).toMatchObject({ stage: "Queued", escalatedTo: null, reason: null });
    expect(requeued.brief).toContain("Add the flag.");
    expect(requeued.brief).toContain("The build command.");
    expect(h.t3.launches).toHaveLength(0);
  });

  it("gives a task with no brief and no work back as newly admitted, with the owner's answer", async () => {
    const h = harness();
    const id = await askedBeforeWork(h, null);
    h.tasks.update(id, { hermesTaskId: "t_h" });
    await h.pipeline.park(id, {});

    const admittedAgain = await h.pipeline.unpark(id, "The build command.");

    expect(admittedAgain).toMatchObject({
      stage: "Admitted",
      escalatedTo: null,
      reason: null,
      deferReason: null,
      deferUntil: null,
    });
    expect(h.board.at(-1)).toBe("t_h hand back: The owner answered: The build command.");
  });

  it("refuses an unpark without an answer", async () => {
    const h = harness();
    const id = await askedOwner(h);
    await h.pipeline.park(id, {});

    await expect(h.pipeline.unpark(id, "  ")).rejects.toThrow(/answer/);
    expect(h.tasks.get(id).stage).toBe("Parked");
  });
});
