import { afterEach, describe, expect, it } from "vitest";
import { runningCard, startDashboard, type Dashboard } from "./dashboard.js";

let dashboard: Dashboard | undefined;

afterEach(async () => {
  await dashboard?.close();
  dashboard = undefined;
});

describe("Pipeline", () => {
  it("groups cards by stage and role with their active threads", async () => {
    dashboard = await startDashboard();
    const { h } = dashboard;
    const implementing = runningCard(h);
    const reviewing = h.cards.create({
      repo: "octo/app",
      issueNumber: 11,
      title: "Under review",
    }).id;
    h.cards.transition(reviewing, "Implementing", "work started");
    h.cards.transition(reviewing, "Reviewing", "PR #6 at 2222222", { reviewThread: "t-rev" });
    h.events.recordThread({
      environmentId: "w1",
      threadId: "t-rev",
      title: "Hephaestus: review card",
      providerInstanceId: "hephaestus-claude",
      model: "opus",
      configVersion: 1,
      cardId: String(reviewing),
      kind: "review",
    });

    const { status, html } = await dashboard.get("/pipeline");

    expect(status).toBe(200);
    expect(html).toContain('id="stage-Implementing"');
    expect(html).toContain('id="stage-Reviewing"');
    expect(html).toContain(`href="/work/${String(implementing)}"`);
    expect(html).toContain(`href="/work/${String(reviewing)}"`);
    expect(html).toContain('href="/threads/w1/t-impl"');
    expect(html).toContain('href="/threads/w1/t-rev"');
    expect(html).toContain("Review on w1, Factory Claude");
    expect(html).toContain("2 running factory threads");
  });

  it("says why no thread can start", async () => {
    dashboard = await startDashboard();
    dashboard.h.pipeline.setPaused(true);

    const { html } = await dashboard.get("/pipeline");

    expect(html).toContain("The factory is paused.");
  });

  it("says when the pipeline is empty", async () => {
    dashboard = await startDashboard();

    expect((await dashboard.get("/pipeline")).html).toContain("No card is in the pipeline.");
  });

  it("shows the store error banner when the store cannot be read", async () => {
    dashboard = await startDashboard();
    dashboard.h.db.close();

    const { status, html } = await dashboard.get("/pipeline");

    expect(status).toBe(200);
    expect(html).toContain("Hephaestus could not read its store");
  });
});
