import { describe, expect, it } from "vitest";
import { analytics } from "../../src/factory/analytics.js";
import { TaskStore } from "../../src/factory/tasks.js";
import { openStore } from "../../src/store.js";

describe("analytics", () => {
  it("counts PRs, merges, reverts, escalations, and cycle time per day and project", () => {
    let clock = Date.parse("2026-11-20T10:00:00Z");
    const db = openStore(":memory:");
    const tasks = new TaskStore(db, () => new Date(clock));
    const a = tasks.create({ repo: "octo/app", issueNumber: 1, title: "a" }).id;
    tasks.update(a, { startedAt: new Date(clock).toISOString() });
    tasks.transition(a, "Implementing", "work started");
    tasks.transition(a, "Reviewing", "PR #5 at x");
    tasks.transition(a, "Merging", "approved at x");
    tasks.recordMerge("octo/app", 5, "m", a, false);
    tasks.transition(a, "Validating", "merged");
    clock += 4 * 3_600_000;
    tasks.transition(a, "Done", "checks passed");

    clock = Date.parse("2026-11-22T10:00:00Z");
    const b = tasks.create({ repo: "octo/lib", issueNumber: 2, title: "b" }).id;
    tasks.transition(b, "Escalated", "to the owner");

    const now = new Date("2026-11-25T12:00:00Z");
    const all = analytics(db, { days: 7, now });
    expect(all.days).toHaveLength(7);
    expect(all.days[0]?.day).toBe("2026-11-19");
    expect(all.days.find((day) => day.day === "2026-11-20")).toMatchObject({
      prs: 1,
      merges: 1,
      cycleHours: 4,
    });
    expect(all.days.find((day) => day.day === "2026-11-21")?.cycleHours).toBeNull();
    expect(all.totals).toMatchObject({ prs: 1, merges: 1, reverts: 0, escalations: 1 });
    expect(all.cycleHours).toEqual({ median: 4, p90: 4, count: 1 });

    // Entering Reverting is not a revert; a merged revert PR is, once.
    tasks.transition(b, "Implementing", "restarted");
    tasks.recordMerge("octo/lib", 9, "r", b, true);
    expect(analytics(db, { days: 7, now }).totals.reverts).toBe(1);

    const lib = analytics(db, { repo: "octo/lib", days: 7, now });
    expect(lib.totals).toMatchObject({ prs: 0, merges: 0, escalations: 1 });
    expect(lib.cycleHours.count).toBe(0);
  });
});
