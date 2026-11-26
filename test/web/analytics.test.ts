import { afterEach, describe, expect, it } from "vitest";
import type { Harness } from "../factory/harness.js";
import { NOW, startDashboard, type Dashboard } from "./dashboard.js";

let dashboard: Dashboard | undefined;

afterEach(async () => {
  await dashboard?.close();
  dashboard = undefined;
});

/** One card in `repo` that opened a PR, merged, and finished 4 hours after it started. */
function shipped(h: Harness, repo: string, issue: number): void {
  h.setClock(NOW - 2 * 86_400_000);
  const id = h.cards.create({ repo, issueNumber: issue, title: `Work ${String(issue)}` }).id;
  h.cards.update(id, { startedAt: new Date(NOW - 2 * 86_400_000).toISOString() });
  h.cards.transition(id, "Implementing", "work started");
  h.cards.transition(id, "Reviewing", "PR #5 at abc");
  h.cards.transition(id, "Merging", "approved");
  h.cards.recordMerge(repo, issue, "m", id, false);
  h.cards.transition(id, "Validating", "merged");
  h.setClock(NOW - 2 * 86_400_000 + 4 * 3_600_000);
  h.cards.transition(id, "Done", "checks passed");
}

describe("Analytics", () => {
  it("charts PRs, merges, reverts, cycle time, and escalations for all projects", async () => {
    dashboard = await startDashboard();
    shipped(dashboard.h, "octo/app", 1);
    shipped(dashboard.h, "octo/lib", 2);

    const { status, html } = await dashboard.get("/analytics");

    expect(status).toBe(200);
    expect(html).toContain('<svg class="plot"');
    expect(html).toContain('role="img"');
    expect(html).toContain('<option value="octo/lib"');
    expect(html).toMatch(/<span class="num">2<\/span><span class="meta">PRs<\/span>/);
    expect(html).toMatch(/<span class="num">2<\/span><span class="meta">Merges<\/span>/);
    expect(html).toContain("4.0 h");
    expect(html).toContain('<details class="as-table">');
    expect(html).toContain("Nov 23");
  });

  it("charts one project", async () => {
    dashboard = await startDashboard();
    shipped(dashboard.h, "octo/app", 1);
    shipped(dashboard.h, "octo/lib", 2);

    const { html } = await dashboard.get("/analytics?project=octo%2Flib&days=7");

    expect(html).toContain('<option value="octo/lib" selected>');
    expect(html).toMatch(/<span class="num">1<\/span><span class="meta">PRs<\/span>/);
    expect(html).toContain("Last 7 days");
  });

  it("says when there is nothing to chart", async () => {
    dashboard = await startDashboard();

    const { html } = await dashboard.get("/analytics");

    expect(html).toContain("Nothing to chart yet.");
    expect(html).not.toContain('<svg class="plot"');
  });

  it("shows the store error banner when the store cannot be read", async () => {
    dashboard = await startDashboard();
    dashboard.h.db.close();

    const { status, html } = await dashboard.get("/analytics");

    expect(status).toBe(200);
    expect(html).toContain("Hephaestus could not read its store");
    expect(html).not.toContain('<svg class="plot"');
  });

  it("disables the filters on a store error and keeps them in Try again", async () => {
    dashboard = await startDashboard();
    dashboard.h.db.close();

    const { html } = await dashboard.get("/analytics?project=octo%2Fapp&days=7");

    expect(html).toContain('<select id="project" name="project" disabled>');
    expect(html).toContain('<select id="days" name="days" disabled>');
    expect(html).toContain('href="/analytics?project=octo%2Fapp&amp;days=7">Try again</a>');
  });
});
