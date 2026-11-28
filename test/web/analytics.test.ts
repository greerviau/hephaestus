import { afterEach, describe, expect, it } from "vitest";
import { PROJECT_COOKIE } from "../../src/web/shell.js";
import type { Harness } from "../factory/harness.js";
import { NOW, startDashboard, type Dashboard } from "./dashboard.js";

let dashboard: Dashboard | undefined;

afterEach(async () => {
  await dashboard?.close();
  dashboard = undefined;
});

/** One task in `repo` that opened a PR, merged, and finished 4 hours after it started. */
function shipped(h: Harness, repo: string, issue: number): void {
  h.setClock(NOW - 2 * 86_400_000);
  const id = h.tasks.create({ repo, issueNumber: issue, title: `Work ${String(issue)}` }).id;
  h.tasks.update(id, { startedAt: new Date(NOW - 2 * 86_400_000).toISOString() });
  h.tasks.transition(id, "Queued", "the lead queued the work");
  h.tasks.transition(id, "Implementing", "work started");
  h.tasks.transition(id, "Reviewing", "PR #5 at abc");
  h.tasks.transition(id, "Merging", "approved");
  h.tasks.recordMerge(repo, issue, "m", id, false);
  h.tasks.transition(id, "Validating", "merged");
  h.setClock(NOW - 2 * 86_400_000 + 4 * 3_600_000);
  h.tasks.transition(id, "Done", "checks passed");
}

/** The page's main region, so the sidebar's own links and forms do not match. */
function main(html: string): string {
  return html.slice(html.indexOf('<main id="main"'));
}

describe("Analytics", () => {
  it("shows totals and charts PRs, finished tasks, escalations, and cycle time for all projects", async () => {
    dashboard = await startDashboard();
    shipped(dashboard.h, "octo/app", 1);
    shipped(dashboard.h, "octo/lib", 2);

    const { status, html } = await dashboard.get("/analytics");
    const page = main(html);

    expect(status).toBe(200);
    expect(page).toContain('<ul class="totals">');
    expect(page).toContain("<li><b>2</b><span>PRs</span></li>");
    expect(page).toContain("<li><b>2</b><span>Merged</span></li>");
    expect(page).toContain(
      "<li><b>4.0 h</b><span>Median cycle time</span><span>p90 4.0 h, 2 tasks</span></li>",
    );
    expect(page).toContain("<h2>Finished tasks per day</h2>");
    expect(page).toContain("Merged 2</li>");
    expect(page).toContain("Reverted 0</li>");
    expect(page).toContain(
      'role="img" aria-label="Merged, reverted, and abandoned tasks per day: 2 merged, 0 reverted, 0 abandoned."',
    );
    expect(page).toContain("<h3>PRs at the merge gate</h3>");
    expect(page).toContain("<h3>Escalations</h3>");
    expect(page).toContain("<h3>Median cycle time, hours</h3>");
    expect(page.match(/role="img"/g)).toHaveLength(4);
    expect(page).toContain("Nov 23");
  });

  it("gives every chart hover tips with each day's numbers and hatches the reverted series", async () => {
    dashboard = await startDashboard();
    shipped(dashboard.h, "octo/app", 1);

    const page = main((await dashboard.get("/analytics?days=7")).html);

    expect(page).toContain('<script src="/assets/chart-tip.js" defer></script>');
    expect(page).toContain('data-tip="Nov 23\nMerged 1\nReverted 0\nAbandoned 0"');
    expect(page).toContain('data-tip="Nov 24\nMerged 0\nReverted 0\nAbandoned 0"');
    expect(page).toContain('data-tip="Nov 23\nPRs 1"');
    expect(page).toContain('data-tip="Nov 23\nEscalations 0"');
    expect(page).toContain('data-tip="Nov 23\nMedian cycle time 4.0 h"');
    expect(page).toContain('data-tip="Nov 24\nMedian cycle time: no reading"');
    // Seven days in each of four charts.
    expect(page.match(/<g class="hit"/g)).toHaveLength(28);
    // The browser's own title tips would show beside ours.
    expect(page).not.toContain("<title>");
    expect(page).toContain('<pattern id="hatch-finished"');
    expect(page).toContain(
      '<div class="chart-scroll" tabindex="0" role="region" aria-label="Finished tasks per day chart">',
    );
  });

  it("serves the script that shows the hover tips", async () => {
    dashboard = await startDashboard();

    const response = await fetch(`${dashboard.base}/assets/chart-tip.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(await response.text()).toContain("data-tip");
  });

  it("folds one table of every day's numbers into a focusable scroll region, newest day first", async () => {
    dashboard = await startDashboard();
    shipped(dashboard.h, "octo/app", 1);

    const page = main((await dashboard.get("/analytics?days=7")).html);

    expect(page).toContain('<details class="fold"><summary>Show as a table</summary>');
    expect(page).toContain(
      '<div class="table-region" tabindex="0" role="region" aria-label="Daily numbers">',
    );
    expect(page).toContain(
      '<tr><th scope="col">Day</th><th scope="col" class="r">Merged</th><th scope="col" class="r">Reverted</th><th scope="col" class="r">Abandoned</th><th scope="col" class="r">PRs</th><th scope="col" class="r">Escalations</th><th scope="col" class="r">Cycle</th></tr>',
    );
    expect(page).toContain(
      '<tr><th scope="row">Nov 23</th><td class="r">1</td><td class="r">0</td><td class="r">0</td><td class="r">1</td><td class="r">0</td><td class="r">4.0 h</td></tr>',
    );
    expect(page).toContain('<th scope="row">Nov 25</th><td class="r">0</td>');
    expect(page.match(/<th scope="row">/g)).toHaveLength(7);
    expect(page.indexOf("Nov 25</th>")).toBeLessThan(page.indexOf("Nov 23</th>"));
    expect(page).toMatch(
      /<th scope="row">Nov 25<\/th>(<td class="r">0<\/td>){5}<td class="r">No reading<\/td>/,
    );
  });

  it("offers the period as a segmented control", async () => {
    dashboard = await startDashboard();

    const page = main((await dashboard.get("/analytics?days=7")).html);

    expect(page).toContain('<div class="seg" role="group" aria-label="Period">');
    expect(page).toContain('<a href="/analytics">30 days</a>');
    expect(page).toContain('<a href="/analytics?days=7" aria-current="true">7 days</a>');
    expect(page).toContain('<a href="/analytics?days=90">90 days</a>');
    expect(page).toContain("Days are UTC");
    expect(page).not.toContain("<select");
  });

  it("charts the project the sidebar picker is set to", async () => {
    dashboard = await startDashboard();
    shipped(dashboard.h, "octo/app", 1);
    shipped(dashboard.h, "octo/lib", 2);
    shipped(dashboard.h, "octo/lib", 3);

    const response = await fetch(`${dashboard.base}/analytics?project=octo%2Flib`, {
      headers: { cookie: `${dashboard.cookie}; ${PROJECT_COOKIE}=octo%2Fapp` },
    });
    const page = main(await response.text());

    expect(page).toContain("<li><b>1</b><span>PRs</span></li>");
  });

  it("does not reload itself", async () => {
    dashboard = await startDashboard();

    expect((await dashboard.get("/analytics")).html).not.toContain('http-equiv="refresh"');
  });

  it("says when there is nothing to chart", async () => {
    dashboard = await startDashboard();

    const page = main((await dashboard.get("/analytics")).html);

    expect(page).toContain('<p class="empty">Nothing to chart yet.</p>');
    expect(page).toContain('aria-label="Period"');
    expect(page).not.toContain('role="img"');
    expect(page).not.toContain('class="totals"');
  });

  it("shows the store error banner when the store cannot be read", async () => {
    dashboard = await startDashboard();
    dashboard.h.db.close();

    const { status, html } = await dashboard.get("/analytics?days=7");
    const page = main(html);

    expect(status).toBe(200);
    expect(page).toContain("Hephaestus could not read its store");
    expect(page).toContain("The numbers could not be read.");
    expect(page).toContain('<a href="/analytics?days=7" aria-current="true">7 days</a>');
    expect(page).not.toContain('role="img"');
  });
});
