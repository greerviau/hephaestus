import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "../../src/store.js";
import { T3Adapter } from "../../src/t3/adapter.js";
import { T3Connection } from "../../src/t3/connection.js";
import { ThreadEvents } from "../../src/t3/events.js";
import { ThreadFollower } from "../../src/t3/follower.js";
import { FakeT3 } from "./fake-t3.js";

let fake: FakeT3;
let connection: T3Connection;

beforeEach(async () => {
  fake = new FakeT3();
  await fake.start();
  connection = new T3Connection(fake.url, {
    token: () => Promise.resolve("good-token"),
    renew: () => Promise.resolve(),
  });
});

afterEach(async () => {
  await connection.close();
  await fake.stop();
});

/** A thread whose run moves forward one step on each wait. */
function scriptRun(): void {
  const steps = [
    [{ itemId: "a", position: 0, type: "user_message", status: "completed", text: "Brief" }],
    [
      { itemId: "a", position: 0, type: "user_message", status: "completed", text: "Brief" },
      {
        itemId: "b",
        position: 1,
        type: "command_execution",
        status: "running",
        text: "$ npm test",
      },
    ],
    [
      { itemId: "a", position: 0, type: "user_message", status: "completed", text: "Brief" },
      {
        itemId: "b",
        position: 1,
        type: "command_execution",
        status: "completed",
        text: "$ npm test",
      },
      { itemId: "c", position: 2, type: "assistant_message", status: "completed", text: "Done" },
    ],
  ];
  let step = 0;
  fake.tools.set("t3_thread_wait", () => {
    step = Math.min(step + 1, steps.length - 1);
    const done = step === steps.length - 1;
    return { threadId: "t1", runId: "r1", status: done ? "completed" : "running", timedOut: !done };
  });
  fake.tools.set("t3_thread_read", (args) => {
    const after = Number(args.afterPosition);
    const items = (steps[step] ?? []).filter((item) => item.position > after);
    return {
      thread: { threadId: "t1", status: step === steps.length - 1 ? "completed" : "running" },
      items,
      nextPosition: items.at(-1)?.position ?? after,
      hasMore: false,
    };
  });
}

describe("ThreadFollower", () => {
  it("follows a thread to the end and stores each item once with its final status", async () => {
    scriptRun();
    const events = new ThreadEvents(openStore(":memory:"));
    events.recordThread({
      environmentId: "w1",
      threadId: "t1",
      title: "Implement #42",
      providerInstanceId: "factory-claude",
      model: "claude-sonnet-5-5",
      configVersion: 1,
      cardId: null,
    });
    const follower = new ThreadFollower(new T3Adapter(connection), events, { waitMs: 10 });

    let rounds = 0;
    while (events.following().length > 0 && rounds < 10) {
      await follower.followAll();
      rounds += 1;
    }

    expect(events.thread("w1", "t1")?.status).toBe("completed");
    expect(events.items("w1", "t1").map((item) => [item.itemId, item.status])).toEqual([
      ["a", "completed"],
      ["b", "completed"],
      ["c", "completed"],
    ]);
    const reads = fake.calls.filter((call) => call.name === "t3_thread_read");
    expect(reads.map((call) => call.args.afterPosition)).toEqual([-1, 0]);
  });

  it("keeps following other threads when one environment fails", async () => {
    scriptRun();
    const events = new ThreadEvents(openStore(":memory:"));
    const base = {
      title: "t",
      providerInstanceId: "i",
      model: "m",
      configVersion: 1,
      cardId: null,
    };
    events.recordThread({ ...base, environmentId: "gone", threadId: "x" });
    events.recordThread({ ...base, environmentId: "w1", threadId: "t1" });
    const reads = fake.tools.get("t3_thread_read");
    fake.tools.set("t3_thread_read", (args) => {
      if (args.environmentId === "gone") throw new Error("unreachable");
      return reads?.(args);
    });
    const errors: unknown[] = [];
    const follower = new ThreadFollower(new T3Adapter(connection), events, {
      waitMs: 10,
      onError: (error) => errors.push(error),
    });

    await follower.followAll();

    expect(errors).toHaveLength(1);
    expect(events.items("w1", "t1").length).toBeGreaterThan(0);
  });
});
