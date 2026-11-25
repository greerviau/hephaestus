import { describe, expect, it } from "vitest";
import { analytics } from "../../src/factory/analytics.js";
import { CardStore } from "../../src/factory/cards.js";
import { openStore } from "../../src/store.js";

describe("analytics", () => {
  it("counts PRs, merges, reverts, escalations, and cycle time per day and project", () => {
    let clock = Date.parse("2026-11-20T10:00:00Z");
    const db = openStore(":memory:");
    const cards = new CardStore(db, () => new Date(clock));
    const a = cards.create({ repo: "octo/app", issueNumber: 1, title: "a" }).id;
    cards.update(a, { startedAt: new Date(clock).toISOString() });
    cards.transition(a, "Implementing", "work started");
    cards.transition(a, "Reviewing", "PR #5 at x");
    cards.transition(a, "Merging", "approved at x");
    cards.recordMerge("octo/app", 5, "m", a, false);
    cards.transition(a, "Validating", "merged");
    clock += 4 * 3_600_000;
    cards.transition(a, "Done", "checks passed");

    clock = Date.parse("2026-11-22T10:00:00Z");
    const b = cards.create({ repo: "octo/lib", issueNumber: 2, title: "b" }).id;
    cards.transition(b, "Escalated", "to the owner");

    const now = new Date("2026-11-25T12:00:00Z");
    const all = analytics(db, { days: 7, now });
    expect(all.days).toHaveLength(7);
    expect(all.days[0]?.day).toBe("2026-11-19");
    expect(all.days.find((day) => day.day === "2026-11-20")).toMatchObject({ prs: 1, merges: 1 });
    expect(all.totals).toMatchObject({ prs: 1, merges: 1, reverts: 0, escalations: 1 });
    expect(all.cycleHours).toEqual({ median: 4, p90: 4, count: 1 });

    const lib = analytics(db, { repo: "octo/lib", days: 7, now });
    expect(lib.totals).toMatchObject({ prs: 0, merges: 0, escalations: 1 });
    expect(lib.cycleHours.count).toBe(0);
  });
});
