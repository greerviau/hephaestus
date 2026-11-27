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
