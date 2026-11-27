import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "../../src/store.js";
import { T3Adapter } from "../../src/t3/adapter.js";
import { T3Connection } from "../../src/t3/connection.js";
import { ThreadEvents } from "../../src/t3/events.js";
import { FactoryThreads } from "../../src/t3/threads.js";
import { FakeFailure, FakeT3, delay } from "./fake-t3.js";

let fake: FakeT3;
let connection: T3Connection;
let events: ThreadEvents;
let threads: FactoryThreads;

const launch = {
  environmentId: "w1",
  projectId: "p1",
  title: "Implement #42",
  providerInstanceId: "factory-claude",
  model: "claude-sonnet-5-5",
  runtimeMode: "full-access" as const,
  message: "Brief",
  clientRequestId: "task-7-implement-1",
};
const record = { configVersion: 4, taskId: "task-7" };

beforeEach(async () => {
  fake = new FakeT3();
  await fake.start();
  connection = new T3Connection(fake.url, {
    token: () => Promise.resolve("good-token"),
    renew: () => Promise.resolve(),
  });
  events = new ThreadEvents(openStore(":memory:"));
  threads = new FactoryThreads(new T3Adapter(connection), events);
});

afterEach(async () => {
  await connection.close();
  await fake.stop();
});

describe("FactoryThreads", () => {
  it("records the launch before calling T3, then records the thread for the follower", async () => {
    fake.tools.set("t3_thread_launch", () => {
      expect(events.launch("task-7-implement-1")?.status).toBe("pending");
      return { threadId: "t1", runId: "r1", projectId: "p1" };
    });

    const threadId = await threads.launch(launch, record);

    expect(threadId).toBe("t1");
    expect(events.launch("task-7-implement-1")).toMatchObject({
      status: "launched",
      threadId: "t1",
    });
    expect(events.thread("w1", "t1")).toMatchObject({
      providerInstanceId: "factory-claude",
      configVersion: 4,
      taskId: "task-7",
      status: "starting",
    });
    expect(events.following().map((thread) => thread.threadId)).toEqual(["t1"]);
  });

  it("marks a refused launch as failed and records no thread", async () => {
    fake.tools.set("t3_thread_launch", () => {
      throw new FakeFailure("invalid_request", "No such project");
    });

    await expect(threads.launch(launch, record)).rejects.toThrow(/No such project/);

    expect(events.launch("task-7-implement-1")?.status).toBe("failed");
    expect(events.following()).toEqual([]);
  });

  it("follows a thread again after a message starts a new run", async () => {
    fake.tools.set("t3_thread_launch", () => ({ threadId: "t1", runId: "r1", projectId: "p1" }));
    fake.tools.set("t3_thread_send", () => ({ threadId: "t1", runId: "r2", status: "starting" }));
    await threads.launch(launch, record);
    events.setStatus("w1", "t1", "completed");

    await threads.send("w1", "t1", "Fix the findings", "task-7-round-2");

    expect(events.thread("w1", "t1")?.status).toBe("starting");
    expect(events.following().map((thread) => thread.threadId)).toEqual(["t1"]);
  });
});

describe("FactoryThreads when replies are lost", () => {
  it("keeps a launch pending when T3 may have accepted it", async () => {
    fake.tools.set("t3_thread_launch", () => new Promise(() => undefined));
    await connection.close();
    connection = new T3Connection(fake.url, {
      token: () => Promise.resolve("good-token"),
      renew: () => Promise.resolve(),
    });
    threads = new FactoryThreads(new T3Adapter(connection), events);
    const launching = threads.launch(launch, record).catch(() => undefined);
    await delay(100);
    await connection.close();
    await launching;

    expect(events.launch("task-7-implement-1")?.status).toBe("pending");
  });

  it("puts the thread back on the follower's list before sending, so a lost reply is still followed", async () => {
    fake.tools.set("t3_thread_launch", () => ({ threadId: "t1", runId: "r1", projectId: "p1" }));
    await threads.launch(launch, record);
    events.setStatus("w1", "t1", "completed");
    fake.tools.set("t3_thread_send", () => new Promise(() => undefined));

    const sending = threads
      .send("w1", "t1", "Again", "task-7-round-3")
      .catch((error: unknown) => error);
    await delay(100);
    expect(events.thread("w1", "t1")?.status).toBe("starting");
    await connection.close();

    expect(await sending).toBeInstanceOf(Error);
    expect(events.following().map((thread) => thread.threadId)).toEqual(["t1"]);
  });

  it("restores the old status when T3 refuses the message", async () => {
    fake.tools.set("t3_thread_launch", () => ({ threadId: "t1", runId: "r1", projectId: "p1" }));
    await threads.launch(launch, record);
    events.setStatus("w1", "t1", "completed");
    fake.tools.set("t3_thread_send", () => {
      throw new FakeFailure("invalid_request", "No");
    });

    await expect(threads.send("w1", "t1", "Again", "task-7-round-3")).rejects.toThrow();

    expect(events.thread("w1", "t1")?.status).toBe("completed");
  });
});

/**
 * T3 keys a launch's request id to the MCP session, so after a sign-in change it starts a
 * new thread for the same request id. This fake does the same: every launch call starts one.
 */
function sessionScopedT3(): { started: { threadId: string; title: string }[] } {
  const started: { threadId: string; title: string }[] = [];
  fake.tools.set("t3_thread_launch", (args) => {
    const thread = { threadId: `t${String(started.length + 1)}`, title: String(args.title) };
    started.push(thread);
    return { threadId: thread.threadId, runId: "r1", projectId: "p1" };
  });
  fake.tools.set("t3_thread_list", (args) => ({
    threads: started
      .filter((thread) =>
        thread.title.includes(typeof args.titleContains === "string" ? args.titleContains : ""),
      )
      .reverse()
      .map((thread) => ({ ...thread, status: "running" })),
    nextCursor: null,
  }));
  return { started };
}

/** A launch whose reply never arrives, then a connection that has to sign in again. */
async function loseLaunchReplyThenRenew(): Promise<void> {
  const launching = threads.launch(launch, record).catch(() => undefined);
  await delay(100);
  await connection.close();
  await launching;
  fake.tokens.clear();
  fake.tokens.add("new-token");
  let token = "good-token";
  connection = new T3Connection(fake.url, {
    token: () => Promise.resolve(token),
    renew: () => {
      token = "new-token";
      return Promise.resolve();
    },
  });
  threads = new FactoryThreads(new T3Adapter(connection), events);
}

describe("FactoryThreads after a sign-in change", () => {
  it("adopts the thread a lost launch started instead of starting a second one", async () => {
    const { started } = sessionScopedT3();
    const launchTool = fake.tools.get("t3_thread_launch");
    if (launchTool === undefined) throw new Error("no launch tool");
    // The first launch starts its thread, but the reply is lost.
    fake.tools.set("t3_thread_launch", async (args) => {
      await launchTool(args);
      return new Promise(() => undefined);
    });
    await loseLaunchReplyThenRenew();
    fake.tools.set("t3_thread_launch", launchTool);

    const threadId = await threads.launch(launch, record);

    expect(threadId).toBe("t1");
    expect(started).toHaveLength(1);
    expect(events.launch("task-7-implement-1")).toMatchObject({
      status: "launched",
      threadId: "t1",
    });
    expect(events.following().map((thread) => thread.threadId)).toEqual(["t1"]);
  });

  it("launches again when T3 has no thread for the lost launch", async () => {
    const { started } = sessionScopedT3();
    const launchTool = fake.tools.get("t3_thread_launch");
    if (launchTool === undefined) throw new Error("no launch tool");
    fake.tools.set("t3_thread_launch", () => new Promise(() => undefined));
    await loseLaunchReplyThenRenew();
    fake.tools.set("t3_thread_launch", launchTool);

    const threadId = await threads.launch(launch, record);

    expect(threadId).toBe("t1");
    expect(started).toHaveLength(1);
  });

  it("does not launch while T3 cannot list threads, and keeps the launch pending", async () => {
    const { started } = sessionScopedT3();
    events.recordLaunch(launch.clientRequestId, { ...launch, ...record });
    fake.tools.set("t3_thread_list", () => {
      throw new FakeFailure("environment_unreachable", "Offline");
    });

    await expect(threads.launch(launch, record)).rejects.toThrow(/Offline/);

    expect(started).toHaveLength(0);
    expect(events.launch("task-7-implement-1")?.status).toBe("pending");
  });

  it("does not adopt another task's thread or a thread already recorded", async () => {
    const { started } = sessionScopedT3();
    // A thread whose title contains this launch's title, and an earlier thread for the
    // same task that Hephaestus already knows.
    started.push({ threadId: "other", title: `${launch.title}5: another task` });
    started.push({ threadId: "earlier", title: launch.title });
    events.recordThread({ ...launch, ...record, threadId: "earlier" });
    events.recordLaunch(launch.clientRequestId, { ...launch, ...record });

    const threadId = await threads.launch(launch, record);

    expect(threadId).toBe("t3");
    expect(started.map((thread) => thread.threadId)).toEqual(["other", "earlier", "t3"]);
  });
});

describe("FactoryThreads.reconcile", () => {
  it("adopts a pending launch whose thread T3 has", async () => {
    const { started } = sessionScopedT3();
    started.push({ threadId: "t1", title: launch.title });
    events.recordLaunch(launch.clientRequestId, { ...launch, ...record });

    await threads.reconcile();

    expect(events.launch("task-7-implement-1")).toMatchObject({
      status: "launched",
      threadId: "t1",
    });
    expect(events.thread("w1", "t1")).toMatchObject({ taskId: "task-7", configVersion: 4 });
    expect(fake.calls.filter((call) => call.name === "t3_thread_launch")).toHaveLength(0);
  });

  it("marks a pending launch failed when T3 has no thread for it", async () => {
    sessionScopedT3();
    events.recordLaunch(launch.clientRequestId, { ...launch, ...record });

    await threads.reconcile();

    expect(events.launch("task-7-implement-1")).toMatchObject({ status: "failed" });
    expect(events.following()).toEqual([]);
  });

  it("leaves a pending launch for later when T3 cannot list threads", async () => {
    sessionScopedT3();
    events.recordLaunch(launch.clientRequestId, { ...launch, ...record });
    fake.tools.set("t3_thread_list", () => {
      throw new FakeFailure("environment_unreachable", "Offline");
    });

    await threads.reconcile();

    expect(events.launch("task-7-implement-1")?.status).toBe("pending");
  });
});
