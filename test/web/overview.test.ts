import { afterEach, describe, expect, it } from "vitest";
import type { WorkerView } from "../../src/workers/manager.js";
import { SHA } from "../factory/harness.js";
import {
  escalatedCard,
  externalIssue,
  linked,
  runningCard,
  startDashboard,
  type Dashboard,
} from "./dashboard.js";

let dashboard: Dashboard | undefined;

afterEach(async () => {
  await dashboard?.close();
  dashboard = undefined;
});

function signInWorker(): WorkerView {
  return {
    environmentId: "w1",
    label: "worker one",
    enabled: true,
    home: "/home/w",
    deployedVersion: 1,
    deployedSha: "abc",
    instances: {},
    tasks: {},
    claude: "unknown",
    codex: "unknown",
    ready: false,
    blocker: "Sign in Factory Claude.",
    ownerStep: true,
  };
}

describe("Overview", () => {
  it("counts and lists everything that needs the owner, each with its action", async () => {
    dashboard = await startDashboard({
      environments: { environments: () => Promise.resolve(linked(3)) },
      workers: [signInWorker()],
    });
    const { h, store } = dashboard;
    const card = escalatedCard(h);
    await externalIssue(h);
    h.cards.notify("Reverted PR #9 in octo/app", card);
    const deployed = store.list()[0];
    store.createVersion({
      document: deployed?.document ?? ({} as never),
      author: "improver",
      message: "Tighten the review skill",
      parentId: deployed?.id ?? 1,
    });

    const { status, html } = await dashboard.get("/");

    expect(status).toBe(200);
    // Escalated card, external issue, proposal, expiring link, worker sign-in, notification.
    expect(html).toContain("6 need you");
    expect(html).toContain("Fix &lt;the&gt; parser");
    expect(html).toContain("The PR touches .github/workflows/ci.yml");
    expect(html).toContain(`action="/work/${String(card)}/approve-merge"`);
    expect(html).toContain(`name="headSha" value="${SHA}"`);
    expect(html).toContain(`action="/work/${String(card)}/send-to-lead"`);
    expect(html).toContain(`action="/work/${String(card)}/abandon"`);
    expect(html).toContain("Crash on &lt;empty&gt; input");
    expect(html).toContain('action="/work/issues/admit"');
    expect(html).toContain('action="/work/issues/reject"');
    expect(html).toContain("Tighten the review skill");
    expect(html).toContain('href="/improvement#v2"');
    expect(html).toContain("worker one: the T3 link expires in 3 days");
    expect(html).toContain("Sign in Factory Claude.");
    expect(html).toContain("Reverted PR #9 in octo/app");
    expect(html).toContain("/dismiss");
  });

  it("shows work in progress with its running threads, and finished counts", async () => {
    dashboard = await startDashboard();
    const { h } = dashboard;
    const running = runningCard(h);
    const waiting = h.cards.create({ repo: "octo/app", issueNumber: 9, title: "Queued work" }).id;
    h.cards.transition(waiting, "Implementing", "work started", {
      waiting: "The limit of 2 running factory threads is reached.",
    });
    const done = h.cards.create({ repo: "octo/app", issueNumber: 10, title: "Shipped work" }).id;
    h.cards.transition(done, "Abandoned", "not needed");

    const { html } = await dashboard.get("/");

    expect(html).toContain("0 need you");
    expect(html).not.toContain("the T3 link expires");
    expect(html).toContain(`href="/work/${String(running)}"`);
    expect(html).toContain("Implement on w1, Factory Codex");
    expect(html).toContain('href="/threads/w1/t-impl"');
    expect(html).toContain("The limit of 2 running factory threads is reached.");
    expect(html).toContain("1 abandoned");
    expect(html).toContain("Shipped work");
  });

  it("says when nothing needs the owner and nothing is running", async () => {
    dashboard = await startDashboard();

    const { status, html } = await dashboard.get("/");

    expect(status).toBe(200);
    expect(html).toContain("Nothing needs you.");
    expect(html).toContain("No work in progress.");
    expect(html).toContain("Finished work appears here");
  });

  it("pauses and resumes the factory", async () => {
    dashboard = await startDashboard();

    expect((await dashboard.get("/")).html).toContain('action="/factory/pause"');
    const paused = await dashboard.post("/factory/pause", { back: "/" });
    expect(paused.status).toBe(303);
    expect(paused.headers.get("location")).toBe("/?notice=paused");
    expect(dashboard.h.pipeline.paused()).toBe(true);
    const html = (await dashboard.get("/?notice=paused")).html;
    expect(html).toContain("The factory is paused");
    expect(html).toContain('action="/factory/resume"');

    await dashboard.post("/factory/resume", { back: "/" });
    expect(dashboard.h.pipeline.paused()).toBe(false);
  });

  it("approves a merge at the head commit, and refuses a stale one", async () => {
    dashboard = await startDashboard();
    const card = escalatedCard(dashboard.h);

    const stale = await dashboard.post(`/work/${String(card)}/approve-merge`, {
      headSha: "f".repeat(40),
      back: "/",
    });
    expect(stale.headers.get("location")).toBe("/?notice=merge-refused");
    expect(dashboard.h.cards.get(card).stage).toBe("Escalated");

    const approved = await dashboard.post(`/work/${String(card)}/approve-merge`, {
      headSha: SHA,
      back: "/",
    });
    expect(approved.headers.get("location")).toBe("/?notice=merge-approved");
    expect(dashboard.h.cards.get(card)).toMatchObject({ stage: "Merging", ownerApprovedSha: SHA });
  });

  it("sends a card to the lead and abandons one", async () => {
    dashboard = await startDashboard();
    const card = escalatedCard(dashboard.h);

    await dashboard.post(`/work/${String(card)}/send-to-lead`, { note: "Split the CI change out" });
    expect(dashboard.h.cards.get(card)).toMatchObject({
      escalatedTo: "lead",
      reason: "Split the CI change out",
    });

    const abandoned = await dashboard.post(`/work/${String(card)}/abandon`, {
      reason: "Not needed",
    });
    expect(abandoned.headers.get("location")).toBe(`/work/${String(card)}?notice=abandoned`);
    expect(dashboard.h.cards.get(card).stage).toBe("Abandoned");
  });

  it("dismisses a notification", async () => {
    dashboard = await startDashboard();
    dashboard.h.cards.notify("Something happened");
    const [first] = dashboard.h.cards.notifications();

    await dashboard.post(`/notifications/${String(first?.id)}/dismiss`, { back: "/" });

    expect(dashboard.h.cards.notifications()).toEqual([]);
  });

  it("shows the store error banner and turns actions off when the store cannot be read", async () => {
    dashboard = await startDashboard();
    escalatedCard(dashboard.h);
    dashboard.h.db.close();

    const { status, html } = await dashboard.get("/");

    expect(status).toBe(200);
    expect(html).toContain("Hephaestus could not read its store");
    expect(html).not.toContain("database connection is not open");
    expect(html).not.toContain('action="/factory/pause"');
  });

  it("shows the T3 error banner without upstream text", async () => {
    dashboard = await startDashboard({
      environments: { environments: () => Promise.reject(new Error("401 Bearer secret-token")) },
    });

    const { html } = await dashboard.get("/");

    expect(html).toContain("T3 could not be reached");
    expect(html).not.toContain("secret-token");
  });

  it("shows T3 sections as loading and refreshes while T3 has not answered", async () => {
    dashboard = await startDashboard({
      environments: { environments: () => new Promise(() => undefined) },
      t3WaitMs: 20,
    });

    const { status, html } = await dashboard.get("/");

    expect(status).toBe(200);
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain("Checking T3 links...");
  });

  it("refuses actions from another origin", async () => {
    dashboard = await startDashboard();

    const response = await fetch(`${dashboard.base}/factory/pause`, {
      method: "POST",
      headers: { cookie: dashboard.cookie, origin: "http://evil.example" },
      redirect: "manual",
    });

    expect(response.status).toBe(403);
    expect(dashboard.h.pipeline.paused()).toBe(false);
  });
});
