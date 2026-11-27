import { describe, expect, it } from "vitest";
import { T3ToolError } from "../../src/t3/connection.js";
import { SHA, harness, implementResult, pr, type Harness } from "./harness.js";

/** Records the implement thread a task's launch started, as T3 answered it, before the task learned of it. */
function recordedThread(h: Harness, id: number, threadId: string): void {
  lostLaunch(h, id);
  h.events.recordThread({
    environmentId: "w1",
    threadId,
    title: "Task",
    providerInstanceId: "hephaestus-claude",
    model: "m",
    configVersion: 3,
    taskId: String(id),
    kind: "implement",
  });
  h.events.finishLaunch(`hephaestus-implement-${String(id)}-0`, { threadId });
}

/** Records a launch of the task's implement thread whose reply never came. */
function lostLaunch(h: Harness, id: number): void {
  h.events.recordLaunch(`hephaestus-implement-${String(id)}-0`, {
    environmentId: "w1",
    title: "Task",
    providerInstanceId: "hephaestus-claude",
    model: "m",
    configVersion: 3,
    taskId: String(id),
    kind: "implement",
  });
}

let nextIssue = 10;

/** An admitted task for a new issue, with a task on the Hermes board. */
function admitted(h: Harness, title: string): number {
  const number = nextIssue++;
  h.github.issues.set(number, {
    number,
    title,
    body: `Body of ${title}.`,
    author: "owner",
    state: "OPEN",
  });
  const id = h.tasks.create({ repo: "octo/app", issueNumber: number, title }).id;
  h.tasks.update(id, { hermesTaskId: `h${String(id)}` });
  return id;
}

function oneThread(h: Harness): Harness {
  h.config.factory.limits.threads = 1;
  return h;
}

/** Frees the slot a running task holds: its thread fails, and the task goes on to the owner. */
async function freeSlot(h: Harness, id: number): Promise<void> {
  h.finish(h.tasks.get(id).implementThread ?? "", "", "failed");
  await h.pipeline.tick();
  await h.pipeline.escalateToOwner(id, "needs a decision");
  await h.pipeline.tick();
}

describe("the lead's queue", () => {
  it("keeps a task queued at the limits in Queued, and moves it to Implementing when its thread launches", async () => {
    const h = oneThread(harness());
    const first = admitted(h, "First");
    const second = admitted(h, "Second");
    await h.pipeline.queue(first, "brief one");
    expect(h.tasks.get(first).stage).toBe("Implementing");

    await h.pipeline.queue(second, "brief two");
    expect(h.tasks.get(second)).toMatchObject({
      stage: "Queued",
      brief: "brief two",
      waiting: "The limit of 1 running factory threads is reached.",
    });
    expect(h.t3.launches).toHaveLength(1);
    expect(h.tasks.get(second).startedAt).toBeNull();

    await freeSlot(h, first);
    expect(h.tasks.get(second)).toMatchObject({ stage: "Implementing", waiting: null });
    expect(h.t3.launches[1]?.message).toContain("brief two");
    expect(h.tasks.events(second).map((event) => event.kind)).toContain("stage:Queued");
  });

  it("launches queued tasks in the lead's order, and moves a task queued again", async () => {
    const h = oneThread(harness());
    const running = admitted(h, "Running");
    const a = admitted(h, "A");
    const b = admitted(h, "B");
    const c = admitted(h, "C");
    await h.pipeline.queue(running, "brief");
    await h.pipeline.queue(a, "brief a");
    await h.pipeline.queue(b, "brief b");
    await h.pipeline.queue(c, "brief c", a);
    expect(h.tasks.queue().map((task) => task.id)).toEqual([c, a, b]);

    // Queuing a queued task again moves it and replaces its brief.
    await h.pipeline.queue(b, "brief b2", c);
    expect(h.tasks.queue().map((task) => task.id)).toEqual([b, c, a]);

    await freeSlot(h, running);
    expect(h.t3.launches[1]?.title).toContain("B");
    expect(h.t3.launches[1]?.message).toContain("brief b2");
    expect(h.tasks.get(c).stage).toBe("Queued");
    expect(h.tasks.get(a).stage).toBe("Queued");
  });

  it("gives a slot to a task already in progress before a queued task", async () => {
    const h = oneThread(harness());
    const started = admitted(h, "Started");
    const waiting = admitted(h, "Waiting");
    await h.pipeline.queue(started, "brief");
    await h.pipeline.queue(waiting, "brief");
    h.github.prs.set(5, pr(5, SHA));
    h.finish("t1", implementResult(5, SHA));

    await h.pipeline.tick();
    expect(h.tasks.get(started).stage).toBe("Reviewing");
    expect(h.t3.launches).toHaveLength(2);
    expect(h.tasks.get(waiting).stage).toBe("Queued");
  });

  it("queues a task while paused and starts it on resume", async () => {
    const h = harness();
    const id = admitted(h, "Paused");
    h.pipeline.setPaused(true);
    await h.pipeline.queue(id, "Use the v2 parser.");
    expect(h.tasks.get(id)).toMatchObject({ stage: "Queued", waiting: "The factory is paused." });
    expect(h.t3.launches).toHaveLength(0);

    h.pipeline.setPaused(false);
    await h.pipeline.tick();
    expect(h.tasks.get(id).stage).toBe("Implementing");
    expect(h.t3.launches[0]?.message).toContain("Use the v2 parser.");
  });

  it("refuses to queue a task in progress or before a task that is not queued", async () => {
    const h = harness();
    const started = admitted(h, "Started");
    const other = admitted(h, "Other");
    await h.pipeline.queue(started, "brief");
    await expect(h.pipeline.queue(started, "again")).rejects.toThrow(/Implementing/);
    await expect(h.pipeline.queue(other, "brief", started)).rejects.toThrow(/not queued/);
    expect(h.tasks.get(other).stage).toBe("Admitted");
  });

  it("restarts an escalated task that never started through the queue", async () => {
    const h = oneThread(harness());
    const running = admitted(h, "Running");
    const id = admitted(h, "Never started");
    await h.pipeline.queue(running, "brief");
    await h.pipeline.escalateToOwner(id, "unclear");
    await h.pipeline.sendToLead(id, "it is clear now");

    await h.pipeline.startWork(id, "brief");
    expect(h.tasks.get(id)).toMatchObject({ stage: "Queued", escalatedTo: null });
    expect(h.t3.launches).toHaveLength(1);
  });

  it("defers a task until the task it names is finished, then gives it back to the lead", async () => {
    const h = harness();
    const parent = admitted(h, "Parent");
    const child = admitted(h, "Child");
    // Paused, the queued task stays queued until the lead defers it.
    h.pipeline.setPaused(true);
    await h.pipeline.queue(child, "brief");
    await h.pipeline.defer(child, "needs the parser from the parent", parent);
    h.pipeline.setPaused(false);
    expect(h.tasks.get(child)).toMatchObject({
      stage: "Admitted",
      queueOrder: null,
      deferReason: "needs the parser from the parent",
      deferAfter: parent,
    });
    expect(h.board.at(-1)).toBe(
      `h${String(child)} park: Deferred until task ${String(parent)} is finished: needs the parser from the parent`,
    );

    await h.pipeline.tick();
    expect(h.tasks.get(child).deferReason).not.toBeNull();

    await h.pipeline.abandon(parent, "not needed");
    await h.pipeline.tick();
    expect(h.tasks.get(child)).toMatchObject({ deferReason: null, deferAfter: null });
    expect(h.board.at(-1)).toBe(
      `h${String(child)} hand back: Task ${String(parent)} is finished, so this task is no longer deferred. It was deferred because: needs the parser from the parent`,
    );
    expect(h.t3.launches).toHaveLength(0);
  });

  it("gives a task deferred without a named task back to the lead when any task finishes", async () => {
    const h = harness();
    const other = admitted(h, "Other");
    const id = admitted(h, "Later");
    await h.pipeline.defer(id, "wait for room");
    await h.pipeline.tick();
    expect(h.tasks.get(id).deferReason).toBe("wait for room");

    await h.pipeline.abandon(other, "dropped");
    await h.pipeline.tick();
    expect(h.tasks.get(id).deferReason).toBeNull();
    expect(h.board.at(-1)).toBe(
      `h${String(id)} hand back: A task finished, so this task is no longer deferred. It was deferred because: wait for room`,
    );
  });

  it("refuses a deferral on a task in progress, after itself, or after a finished task", async () => {
    const h = harness();
    const started = admitted(h, "Started");
    const id = admitted(h, "Waiting");
    const gone = admitted(h, "Gone");
    await h.pipeline.queue(started, "brief");
    await h.pipeline.abandon(gone, "dropped");
    await expect(h.pipeline.defer(started, "later")).rejects.toThrow(/Implementing/);
    await expect(h.pipeline.defer(id, "later", id)).rejects.toThrow(/itself/);
    await expect(h.pipeline.defer(id, "later", gone)).rejects.toThrow(/finished/);
    await expect(h.pipeline.defer(id, "later", 999)).rejects.toThrow(/no task 999/);
  });

  it("refuses to defer a queued task whose launch may already have started a thread", async () => {
    const h = harness();
    const id = admitted(h, "Launching");
    h.pipeline.setPaused(true);
    await h.pipeline.queue(id, "brief");
    // A launch was recorded and its reply never came, so T3 may have the thread.
    lostLaunch(h, id);
    await expect(h.pipeline.defer(id, "later")).rejects.toThrow(/starting/);
    await expect(h.pipeline.queue(id, "another brief")).rejects.toThrow(/starting/);
    expect(h.tasks.get(id)).toMatchObject({ stage: "Queued", brief: "brief" });
  });

  it("replays a queued task's lost launch though tasks ahead of it are held back", async () => {
    const h = oneThread(harness());
    const a = admitted(h, "A");
    const b = admitted(h, "B");
    h.pipeline.setPaused(true);
    await h.pipeline.queue(a, "brief a");
    lostLaunch(h, a);
    await h.pipeline.queue(b, "brief b", a);
    h.pipeline.setPaused(false);

    await h.pipeline.tick();
    expect(h.tasks.get(a).stage).toBe("Implementing");
    expect(h.t3.launches[0]?.clientRequestId).toBe(`hephaestus-implement-${String(a)}-0`);
    expect(h.tasks.get(b)).toMatchObject({
      stage: "Queued",
      waiting: "The limit of 1 running factory threads is reached.",
    });
  });

  it("gives a task in progress its slot before a task the lead queues meanwhile", async () => {
    const h = oneThread(harness());
    const started = admitted(h, "Started");
    const next = admitted(h, "Next");
    await h.pipeline.queue(started, "brief");
    h.github.prs.set(5, pr(5, SHA));
    h.finish("t1", implementResult(5, SHA));

    // The lead queues before the next pass sees the finished thread.
    await h.pipeline.queue(next, "brief");
    expect(h.tasks.get(started).stage).toBe("Reviewing");
    expect(h.tasks.get(next).stage).toBe("Queued");
    expect(h.t3.launches).toHaveLength(2);
  });

  it("holds back the tasks after a queued task whose start fails", async () => {
    const h = harness();
    const a = admitted(h, "A");
    const b = admitted(h, "B");
    h.pipeline.setPaused(true);
    await h.pipeline.queue(a, "brief a");
    await h.pipeline.queue(b, "brief b");
    h.pipeline.setPaused(false);
    const read = h.github.issue.bind(h.github);
    h.github.issue = (repo, number) =>
      number === h.tasks.get(a).issueNumber
        ? Promise.reject(new Error("HTTP 503"))
        : read(repo, number);

    await h.pipeline.tick();
    expect(h.t3.launches).toHaveLength(0);
    expect(h.tasks.get(b)).toMatchObject({
      stage: "Queued",
      waiting: `Task ${String(a)} is ahead of it in the queue and could not start.`,
    });

    h.github.issue = read;
    await h.pipeline.tick();
    expect(h.t3.launches.map((launch) => launch.title)).toEqual([
      `Task ${String(a)}: A`,
      `Task ${String(b)}: B`,
    ]);
  });

  it("refuses a deferral the board cannot park, and keeps a deferral until the board takes the hand-back", async () => {
    const h = harness();
    const parent = admitted(h, "Parent");
    const id = admitted(h, "Child");
    const board = h.hermesBoard;
    const park = board.park.bind(board);
    board.park = () => Promise.reject(new Error("Hermes is down"));
    await expect(h.pipeline.defer(id, "later", parent)).rejects.toThrow(/Hermes is down/);
    expect(h.tasks.get(id).deferReason).toBeNull();

    board.park = park;
    await h.pipeline.defer(id, "later", parent);
    await h.pipeline.abandon(parent, "dropped");
    const handBack = board.handBack.bind(board);
    board.handBack = () => Promise.reject(new Error("Hermes is down"));
    await h.pipeline.tick();
    expect(h.tasks.get(id).deferReason).toBe("later");

    board.handBack = handBack;
    await h.pipeline.tick();
    expect(h.tasks.get(id).deferReason).toBeNull();
    expect(h.board.at(-1)).toContain("hand back: Task");
  });

  it("tells the owner on a later pass when the alert could not be recorded", async () => {
    const h = harness((config) => {
      config.factory.triageAlertMinutes = 30;
    });
    admitted(h, "Untriaged");
    const notify = h.tasks.notify.bind(h.tasks);
    h.tasks.notify = () => {
      throw new Error("disk full");
    };
    h.setClock(Date.parse("2026-11-25T12:31:00Z"));
    await h.pipeline.tick();
    h.tasks.notify = notify;
    await h.pipeline.tick();
    expect(h.tasks.notifications()).toHaveLength(1);
  });

  it("takes up the thread a queued task's launch started when the record of it was cut short", async () => {
    const h = oneThread(harness());
    const a = admitted(h, "A");
    const b = admitted(h, "B");
    h.pipeline.setPaused(true);
    await h.pipeline.queue(a, "brief a");
    await h.pipeline.queue(b, "brief b");
    // T3 started A's thread and Hephaestus recorded it, but the task never learned of it.
    lostLaunch(h, a);
    h.events.recordThread({
      environmentId: "w1",
      threadId: "t-a",
      title: "Task",
      providerInstanceId: "hephaestus-claude",
      model: "m",
      configVersion: 3,
      taskId: String(a),
      kind: "implement",
    });
    h.events.finishLaunch(`hephaestus-implement-${String(a)}-0`, { threadId: "t-a" });
    await expect(h.pipeline.defer(a, "later")).rejects.toThrow(/starting/);
    h.pipeline.setPaused(false);

    await h.pipeline.tick();
    expect(h.tasks.get(a)).toMatchObject({
      stage: "Implementing",
      implementThread: "t-a",
      workerEnv: "w1",
    });
    expect(h.t3.launches).toHaveLength(0);
    expect(h.tasks.get(b).stage).toBe("Queued");
  });

  it("starts the task the lead moves ahead while another task prepares its start", async () => {
    const h = oneThread(harness());
    const a = admitted(h, "A");
    const b = admitted(h, "B");
    h.pipeline.setPaused(true);
    await h.pipeline.queue(a, "brief a");
    await h.pipeline.queue(b, "brief b");
    h.pipeline.setPaused(false);
    const branch = h.github.defaultBranch.bind(h.github);
    let moved = false;
    h.github.defaultBranch = async () => {
      if (!moved) {
        moved = true;
        h.tasks.enqueue(b, a, "the lead queued the work", { brief: "brief b" });
      }
      return branch();
    };

    await h.pipeline.tick();
    expect(h.tasks.get(b).stage).toBe("Implementing");
    expect(h.tasks.get(a).stage).toBe("Queued");
    expect(h.t3.launches).toHaveLength(1);
  });

  it("ends a deferral on a task that finishes while the board parks the task", async () => {
    const h = harness();
    const other = admitted(h, "Other");
    const id = admitted(h, "Later");
    const park = h.hermesBoard.park.bind(h.hermesBoard);
    h.hermesBoard.park = async (task, note) => {
      await park(task, note);
      await h.pipeline.abandon(other, "dropped");
    };
    await h.pipeline.defer(id, "wait for room");
    await h.pipeline.tick();
    expect(h.tasks.get(id).deferReason).toBeNull();
  });

  it("never starts an admitted task itself, and tells the owner once when it waits too long", async () => {
    const h = harness((config) => {
      config.factory.triageAlertMinutes = 30;
    });
    const id = admitted(h, "Untriaged");
    const deferred = admitted(h, "Deferred");
    await h.pipeline.defer(deferred, "later");
    h.setClock(Date.parse("2026-11-25T12:29:00Z"));
    await h.pipeline.tick();
    expect(h.tasks.notifications()).toHaveLength(0);

    h.setClock(Date.parse("2026-11-25T12:31:00Z"));
    await h.pipeline.tick();
    await h.pipeline.tick();
    expect(h.t3.launches).toHaveLength(0);
    expect(h.tasks.get(id).stage).toBe("Admitted");
    expect(h.tasks.notifications().map((note) => note.text)).toEqual([
      `Task ${String(id)} in octo/app has waited 30 minutes to be queued or deferred.`,
    ]);
  });

  it("restarts the wait for an alert when a deferred task comes back", async () => {
    const h = harness((config) => {
      config.factory.triageAlertMinutes = 30;
    });
    const other = admitted(h, "Other");
    const id = admitted(h, "Deferred");
    await h.pipeline.queue(other, "brief");
    await h.pipeline.defer(id, "later", other);
    h.setClock(Date.parse("2026-11-25T13:00:00Z"));
    await h.pipeline.abandon(other, "dropped");
    await h.pipeline.tick();
    expect(h.tasks.notifications()).toHaveLength(0);

    h.setClock(Date.parse("2026-11-25T13:31:00Z"));
    await h.pipeline.tick();
    expect(h.tasks.notifications()).toHaveLength(1);
  });

  it("takes up a recorded thread before it starts a task moved ahead of it", async () => {
    const h = harness((config) => {
      config.factory.limits.tasksPerWorker = 1;
    });
    const a = admitted(h, "A");
    const b = admitted(h, "B");
    h.pipeline.setPaused(true);
    await h.pipeline.queue(a, "brief a");
    await h.pipeline.queue(b, "brief b");
    recordedThread(h, a, "t-a");
    h.tasks.enqueue(b, a, "the lead queued the work", { brief: "brief b" });
    h.pipeline.setPaused(false);

    await h.pipeline.tick();

    expect(h.tasks.get(a)).toMatchObject({ stage: "Implementing", implementThread: "t-a" });
    expect(h.tasks.get(b)).toMatchObject({
      stage: "Queued",
      waiting: "The limit of 1 task in progress per worker is reached.",
    });
    expect(h.t3.launches).toHaveLength(0);
  });

  it("closes the pending launch of a thread it takes up, so the thread holds one slot", async () => {
    const h = harness();
    const a = admitted(h, "A");
    h.pipeline.setPaused(true);
    await h.pipeline.queue(a, "brief a");
    lostLaunch(h, a);
    h.events.recordThread({
      environmentId: "w1",
      threadId: "t-a",
      title: "Task",
      providerInstanceId: "hephaestus-claude",
      model: "m",
      configVersion: 3,
      taskId: String(a),
      kind: "implement",
    });
    h.pipeline.setPaused(false);

    await h.pipeline.tick();

    expect(h.tasks.get(a).implementThread).toBe("t-a");
    expect(h.pipeline.runningThreads()).toBe(1);
  });

  it("starts a task whose start a move stopped before the tasks behind it", async () => {
    const h = harness((config) => {
      config.factory.limits.tasksPerWorker = 4;
      config.factory.limits.threadsPerWorker = 4;
    });
    const a = admitted(h, "A");
    const b = admitted(h, "B");
    const c = admitted(h, "C");
    h.pipeline.setPaused(true);
    for (const id of [a, b, c]) await h.pipeline.queue(id, "brief");
    h.pipeline.setPaused(false);
    const branch = h.github.defaultBranch.bind(h.github);
    let moved = false;
    h.github.defaultBranch = async () => {
      if (!moved) {
        moved = true;
        h.tasks.enqueue(b, a, "the lead queued the work", { brief: "brief" });
      }
      return branch();
    };

    await h.pipeline.tick();

    expect(h.t3.launches.map((launch) => launch.title)).toEqual([
      `Task ${String(b)}: B`,
      `Task ${String(a)}: A`,
      `Task ${String(c)}: C`,
    ]);
  });

  it("keeps a queued task on the worker that refused its launch", async () => {
    const h = harness();
    const a = admitted(h, "A");
    const launch = h.t3.launchThread.bind(h.t3);
    h.t3.launchThread = () =>
      Promise.reject(new T3ToolError("t3_thread_launch", "worktree_failed", "no worktree"));
    await h.pipeline.queue(a, "brief");
    expect(h.tasks.get(a)).toMatchObject({ stage: "Queued", workerEnv: "w1" });

    h.t3.launchThread = launch;
    h.ready.splice(0, 1, { environmentId: "w2", label: "w2", home: "/home/w2" });
    await h.pipeline.tick();

    expect(h.t3.launches.filter((sent) => sent.environmentId === "w2")).toHaveLength(0);
    expect(h.tasks.get(a)).toMatchObject({
      stage: "Queued",
      waiting: "The task's worker w1 is not ready.",
    });
    // The lead's later moves keep the task on that worker too.
    await h.pipeline.queue(a, "another brief");
    expect(h.tasks.get(a).workerEnv).toBe("w1");
  });

  it("queues nothing the board cannot take off the lead's list, and parks a task left unparked", async () => {
    const h = harness();
    const a = admitted(h, "A");
    const setStage = h.hermesBoard.setStage.bind(h.hermesBoard);
    h.hermesBoard.setStage = () => Promise.reject(new Error("Hermes is down"));
    await expect(h.pipeline.queue(a, "brief")).rejects.toThrow(/Hermes is down/);
    expect(h.tasks.get(a)).toMatchObject({ stage: "Admitted", brief: null });

    h.hermesBoard.setStage = setStage;
    h.pipeline.setPaused(true);
    await h.pipeline.queue(a, "brief");
    // A task the upgrade queued never had its board task parked.
    h.tasks.update(a, { parkPending: true });
    await h.pipeline.tick();
    expect(h.board.at(-1)).toBe(`h${String(a)} Queued`);
    expect(h.tasks.get(a).parkPending).toBe(false);
  });

  it("starts a task queued while a pass that has passed the queue is still running", async () => {
    const h = harness();
    const running = admitted(h, "Running");
    await h.pipeline.queue(running, "brief");
    h.tasks.update(running, { prNumber: 5, headSha: SHA });
    h.github.prs.set(5, pr(5, SHA));
    // The pass's scan for outside merges waits on GitHub, after the queue already ran.
    let release = (): void => undefined;
    const state = h.github.mergeState.bind(h.github);
    h.github.mergeState = async (repo, number) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return state(repo, number);
    };
    h.setClock(Date.parse("2026-11-25T12:06:00Z"));
    const passing = h.pipeline.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const next = admitted(h, "Next");
    const queued = h.pipeline.queue(next, "brief");
    await new Promise((resolve) => setImmediate(resolve));
    h.github.mergeState = state;
    release();
    await passing;
    await queued;

    expect(h.tasks.get(next).stage).toBe("Implementing");
  });
});
