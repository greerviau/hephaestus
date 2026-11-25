import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThreadEvents } from "../../src/t3/events.js";
import { openStore } from "../../src/store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hephaestus-events-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const thread = {
  environmentId: "worker-1",
  threadId: "thread-1",
  title: "Implement #42",
  providerInstanceId: "factory-claude",
  model: "claude-sonnet-5-5",
  configVersion: 3,
  cardId: "card-7",
};

describe("ThreadEvents", () => {
  it("records a thread with its worker, provider instance, config version and card", () => {
    const events = new ThreadEvents(openStore(":memory:"));
    events.recordThread(thread);

    expect(events.thread("worker-1", "thread-1")).toMatchObject({ ...thread, status: "starting" });
  });

  it("updates an item in place when its status changes, without duplicating it", () => {
    const events = new ThreadEvents(openStore(":memory:"));
    events.recordThread(thread);

    events.upsertItems("worker-1", "thread-1", [
      { itemId: "a", position: 0, type: "user_message", status: "completed", text: "Do it" },
      {
        itemId: "b",
        position: 1,
        type: "command_execution",
        status: "running",
        text: "$ npm test",
      },
    ]);
    events.upsertItems("worker-1", "thread-1", [
      {
        itemId: "b",
        position: 1,
        type: "command_execution",
        status: "completed",
        text: "$ npm test",
      },
      { itemId: "c", position: 2, type: "assistant_message", status: "completed", text: "Done" },
    ]);

    expect(events.items("worker-1", "thread-1").map((item) => [item.itemId, item.status])).toEqual([
      ["a", "completed"],
      ["b", "completed"],
      ["c", "completed"],
    ]);
  });

  it("resumes reading from just before the oldest item that is not final", () => {
    const events = new ThreadEvents(openStore(":memory:"));
    events.recordThread(thread);
    expect(events.resumePosition("worker-1", "thread-1")).toBe(-1);

    events.upsertItems("worker-1", "thread-1", [
      { itemId: "a", position: 0, type: "user_message", status: "completed", text: "" },
      { itemId: "b", position: 1, type: "command_execution", status: "running", text: "" },
      { itemId: "c", position: 2, type: "command_execution", status: "completed", text: "" },
    ]);
    expect(events.resumePosition("worker-1", "thread-1")).toBe(0);

    events.upsertItems("worker-1", "thread-1", [
      { itemId: "b", position: 1, type: "command_execution", status: "completed", text: "" },
    ]);
    expect(events.resumePosition("worker-1", "thread-1")).toBe(2);
  });

  it("keeps threads and items across a restart", () => {
    const path = join(dir, "state.db");
    const first = new ThreadEvents(openStore(path));
    first.recordThread(thread);
    first.upsertItems("worker-1", "thread-1", [
      { itemId: "a", position: 0, type: "user_message", status: "completed", text: "Do it" },
    ]);
    first.setStatus("worker-1", "thread-1", "running");

    const second = new ThreadEvents(openStore(path));

    expect(second.thread("worker-1", "thread-1")?.status).toBe("running");
    expect(second.items("worker-1", "thread-1")).toHaveLength(1);
    expect(second.following().map((t) => t.threadId)).toEqual(["thread-1"]);
  });

  it("stops following a thread once it has ended", () => {
    const events = new ThreadEvents(openStore(":memory:"));
    events.recordThread(thread);
    events.setStatus("worker-1", "thread-1", "completed");

    expect(events.following()).toEqual([]);
  });
});

describe("ThreadEvents.setStatusIf", () => {
  it("changes the status only when it still has the expected value", () => {
    const events = new ThreadEvents(openStore(":memory:"));
    events.recordThread(thread);
    events.setStatus("worker-1", "thread-1", "starting");

    expect(events.setStatusIf("worker-1", "thread-1", "running", "completed")).toBe(false);
    expect(events.thread("worker-1", "thread-1")?.status).toBe("starting");
    expect(events.setStatusIf("worker-1", "thread-1", "starting", "running")).toBe(true);
    expect(events.thread("worker-1", "thread-1")?.status).toBe("running");
  });
});
