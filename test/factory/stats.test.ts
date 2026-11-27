import { describe, expect, it } from "vitest";
import { TaskStore } from "../../src/factory/tasks.js";
import {
  factoryStats,
  formatFactoryStats,
  formatUsageStats,
  parseWindow,
  usageStats,
} from "../../src/factory/stats.js";
import { openStore } from "../../src/store.js";
import { ThreadEvents } from "../../src/t3/events.js";

const NOW = new Date("2026-11-25T12:00:00Z");

describe("parseWindow", () => {
  it("reads hours and days and defaults to 7 days", () => {
    expect(parseWindow("24h", NOW)).toMatchObject({
      label: "24h",
      since: "2026-11-24T12:00:00.000Z",
    });
    expect(parseWindow("30d", NOW).since).toBe("2026-10-26T12:00:00.000Z");
    expect(parseWindow(undefined, NOW)).toMatchObject({
      label: "7d",
      since: "2026-11-18T12:00:00.000Z",
    });
  });

  it("refuses anything else", () => {
    for (const bad of ["", "week", "0d", "-1d", "1.5d", "9999d", "7 days"]) {
      expect(() => parseWindow(bad, NOW)).toThrow(/not valid/);
    }
  });
});

function setup(): {
  db: ReturnType<typeof openStore>;
  tasks: TaskStore;
  at: (iso: string) => void;
} {
  let clock = Date.parse("2026-11-20T10:00:00Z");
  const db = openStore(":memory:");
  const tasks = new TaskStore(db, () => new Date(clock));
  return { db, tasks, at: (iso) => (clock = Date.parse(iso)) };
}

describe("factoryStats", () => {
  it("reports stages, throughput, cycle time, review rounds, escalations, and held issues", () => {
    const { db, tasks, at } = setup();
    const a = tasks.create({ repo: "octo/app", issueNumber: 1, title: "a" }).id;
    tasks.update(a, { startedAt: "2026-11-20T10:00:00.000Z", rounds: 2 });
    tasks.transition(a, "Implementing", "work started");
    at("2026-11-20T14:00:00Z");
    tasks.transition(a, "Done", "merged outside Hephaestus");

    at("2026-11-22T10:00:00Z");
    const b = tasks.create({ repo: "octo/lib", issueNumber: 2, title: "b" }).id;
    tasks.transition(b, "Escalated", "to the owner: the change touches a protected path");
    const c = tasks.create({ repo: "octo/lib", issueNumber: 3, title: "c" }).id;
    tasks.update(c, { startedAt: "2026-11-22T10:00:00.000Z", rounds: 0 });
    tasks.transition(c, "Implementing", "work started");
    at("2026-11-23T10:00:00Z");
    tasks.transition(c, "Done", "merged outside Hephaestus");

    // Done long before the window: not counted as completed in it.
    at("2026-10-01T10:00:00Z");
    const old = tasks.create({ repo: "octo/app", issueNumber: 4, title: "old" }).id;
    tasks.update(old, { startedAt: "2026-10-01T09:00:00.000Z" });
    tasks.transition(old, "Implementing", "work started");
    tasks.transition(old, "Done", "merged outside Hephaestus");

    const insert = db.prepare(
      `INSERT INTO issues (repo, number, title, author, provenance, state, created_at, updated_at)
       VALUES (?, ?, 't', 'o', 'factory', ?, 'x', 'x')`,
    );
    insert.run("octo/app", 10, "held-cap");
    insert.run("octo/app", 11, "held-cap");
    insert.run("octo/app", 12, "awaiting-owner");
    insert.run("octo/lib", 13, "admitted");

    const all = factoryStats(db, { window: "7d", now: NOW });
    expect(all.tasksByStage).toEqual({ Done: 3, Escalated: 1 });
    expect(all.completed).toBe(2);
    expect(all.perDay).toBe(0.29);
    expect(all.cycleHours).toEqual({ median: 4, p90: 24, count: 2 });
    expect(all.reviewRounds).toEqual({ average: 1, max: 2, count: 2 });
    expect(all.escalations.total).toBe(1);
    expect(all.escalations.byTarget).toEqual({ owner: 1 });
    expect(all.escalations.reasons[0]).toMatchObject({
      taskId: b,
      repo: "octo/lib",
      to: "owner",
      reason: "the change touches a protected path",
    });
    expect(all.heldIssues).toEqual([{ repo: "octo/app", awaitingOwner: 1, heldByCap: 2 }]);

    const lib = factoryStats(db, { repo: "octo/lib", window: "7d", now: NOW });
    expect(lib.completed).toBe(1);
    expect(lib.tasksByStage).toEqual({ Done: 1, Escalated: 1 });
    expect(lib.heldIssues).toEqual([]);

    const narrow = factoryStats(db, { window: "24h", now: NOW });
    expect(narrow.completed).toBe(0);
    expect(narrow.escalations.total).toBe(0);
  });

  it("says what is missing instead of showing numbers", () => {
    const { db } = setup();
    const stats = factoryStats(db, { now: NOW });
    expect(stats.cycleHours).toEqual({ median: null, p90: null, count: 0 });
    expect(stats.reviewRounds.average).toBeNull();
    const text = formatFactoryStats(stats);
    expect(text).toContain("there are no tasks yet");
    expect(text).toContain("Cycle time: not available");
    expect(text).toContain("Review rounds: not available");
    expect(text).toContain("Escalations: none");
    expect(text).not.toMatch(/\|/);
  });

  it("formats bullet lines with escalation reasons", () => {
    const { db, tasks } = setup();
    const b = tasks.create({ repo: "octo/lib", issueNumber: 2, title: "b" }).id;
    tasks.transition(b, "Escalated", "to the lead: checks failed twice");
    const text = formatFactoryStats(factoryStats(db, { now: NOW }));
    expect(text).toContain("- Escalations: 1 (1 to the lead).");
    expect(text).toContain("Task 1 (octo/lib): checks failed twice");
    expect(text).not.toMatch(/\|/);
  });
});

describe("usageStats", () => {
  function thread(
    events: ThreadEvents,
    id: string,
    kind: string,
    taskId: number | null,
    model = "m1",
  ): void {
    events.recordThread({
      environmentId: "w1",
      threadId: id,
      title: id,
      providerInstanceId: "i",
      model,
      configVersion: 1,
      taskId: taskId === null ? null : String(taskId),
      kind,
    });
  }

  it("totals what was recorded by role, model, and task, and counts the rest as not recorded", () => {
    const { db, tasks } = setup();
    const events = new ThreadEvents(db, () => new Date("2026-11-24T10:00:00Z"));
    const a = tasks.create({ repo: "octo/app", issueNumber: 1, title: "a" }).id;
    const b = tasks.create({ repo: "octo/lib", issueNumber: 2, title: "b" }).id;
    thread(events, "t1", "implement", a);
    thread(events, "t2", "review", a, "m2");
    thread(events, "t3", "implement", b);
    thread(events, "setup", "setup", null);
    events.setUsage("w1", "t1", { inputTokens: 1000, outputTokens: 200, costUsd: 0.5 });
    events.setUsage("w1", "t2", { inputTokens: 500, outputTokens: 50 });
    // A later report that leaves a field out keeps what was recorded.
    events.setUsage("w1", "t1", { outputTokens: 300 });
    const early = new ThreadEvents(db, () => new Date("2026-10-01T10:00:00Z"));
    thread(early, "old", "implement", a);
    early.setUsage("w1", "old", { inputTokens: 9999, outputTokens: 9999, costUsd: 99 });

    const stats = usageStats(db, { window: "7d", now: NOW });
    expect(stats.total).toMatchObject({
      threads: 3,
      withTokens: 2,
      inputTokens: 1500,
      outputTokens: 350,
      withCost: 1,
      costUsd: 0.5,
    });
    expect(stats.byRole.engineer).toMatchObject({ threads: 2, inputTokens: 1000, withCost: 1 });
    expect(stats.byRole.reviewer).toMatchObject({ threads: 1, costUsd: null });
    expect(stats.byModel.m2).toMatchObject({ threads: 1, outputTokens: 50 });
    expect(stats.byTask.find((task) => task.taskId === a)).toMatchObject({
      threads: 2,
      title: "a",
      inputTokens: 1500,
    });
    expect(stats.byTask.find((task) => task.taskId === b)).toMatchObject({
      threads: 1,
      inputTokens: null,
      costUsd: null,
    });

    const lib = usageStats(db, { repo: "octo/lib", window: "7d", now: NOW });
    expect(lib.total.threads).toBe(1);
    const text = formatUsageStats(stats);
    expect(text).toContain("recorded for 2 of 3");
    expect(text).toContain("cost not recorded");
    expect(text).not.toMatch(/\|/);
  });

  it("says plainly that nothing is recorded when no usage was recorded", () => {
    const { db, tasks } = setup();
    const events = new ThreadEvents(db, () => new Date("2026-11-24T10:00:00Z"));
    const a = tasks.create({ repo: "octo/app", issueNumber: 1, title: "a" }).id;
    thread(events, "t1", "implement", a);
    const stats = usageStats(db, { now: NOW });
    expect(stats.total).toMatchObject({ threads: 1, inputTokens: null, costUsd: null });
    const text = formatUsageStats(stats);
    expect(text).toContain("tokens not recorded");
    expect(text).toContain("cost not recorded");
    expect(text).toContain("any token or dollar figure would be a guess");
    expect(text).not.toMatch(/\$\d/);
  });

  it("says when no thread started in the window", () => {
    const { db } = setup();
    expect(formatUsageStats(usageStats(db, { now: NOW }))).toContain(
      "No engineer or reviewer threads",
    );
  });
});
