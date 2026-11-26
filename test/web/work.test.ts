import { afterEach, describe, expect, it } from "vitest";
import { SHA } from "../factory/harness.js";
import {
  escalatedCard,
  externalIssue,
  runningCard,
  startDashboard,
  type Dashboard,
} from "./dashboard.js";

let dashboard: Dashboard | undefined;

afterEach(async () => {
  await dashboard?.close();
  dashboard = undefined;
});

describe("Work items", () => {
  it("lists cards and tracked issues, with admit and reject on issues awaiting the owner", async () => {
    dashboard = await startDashboard();
    const card = runningCard(dashboard.h);
    await externalIssue(dashboard.h);

    const { status, html } = await dashboard.get("/work");

    expect(status).toBe(200);
    expect(html).toContain(`href="/work/${String(card)}"`);
    expect(html).toContain("Add a cache");
    expect(html).toContain("Crash on &lt;empty&gt; input");
    expect(html).toContain('action="/work/issues/admit"');
    expect(html).toContain('<option value="octo/app"');
  });

  it("leaves a closed issue out of the issues waiting for the owner", async () => {
    dashboard = await startDashboard();
    await externalIssue(dashboard.h);
    const issue = dashboard.h.github.issues.get(42);
    if (issue !== undefined) issue.state = "CLOSED";
    await dashboard.h.intake.poll();

    const { html } = await dashboard.get("/work");

    expect(html).not.toContain("Crash on &lt;empty&gt; input");
    expect(html).toContain("No issue is waiting for you.");
  });

  it("files an issue as the owner's request, which is admitted under the cap", async () => {
    dashboard = await startDashboard();
    const page = (await dashboard.get("/work")).html;
    expect(page).toContain('action="/work/issues/file"');
    expect(page).toContain('<option value="octo/app" selected>octo/app</option>');

    const response = await dashboard.post("/work/issues/file", {
      repo: "octo/app",
      title: "Add a --verbose flag",
      body: "Print each step.",
      back: "/work",
    });
    expect(response.headers.get("location")).toBe("/work?notice=issue-filed");
    const [issue] = dashboard.h.intake.issues(["admitted"]);
    expect(issue).toMatchObject({
      provenance: "factory",
      filedBy: "owner",
      title: "Add a --verbose flag",
    });
    expect(dashboard.h.cards.list()).toHaveLength(1);
  });

  it("accepts a long request in any script", async () => {
    dashboard = await startDashboard();
    const response = await dashboard.post("/work/issues/file", {
      repo: "octo/app",
      title: "長い依頼",
      body: "設計".repeat(2000),
      back: "/work",
    });
    expect(response.headers.get("location")).toBe("/work?notice=issue-filed");
  });

  it("says when an issue could not be filed", async () => {
    dashboard = await startDashboard();
    const response = await dashboard.post("/work/issues/file", {
      repo: "octo/other",
      title: "Anything",
      back: "/work",
    });
    expect(response.headers.get("location")).toBe("/work?notice=file-failed");
  });

  it("filters by project and stage", async () => {
    dashboard = await startDashboard();
    runningCard(dashboard.h);
    const other = dashboard.h.cards.create({ repo: "octo/lib", issueNumber: 3, title: "Lib work" });

    const byProject = (await dashboard.get("/work?project=octo%2Flib")).html;
    expect(byProject).toContain("Lib work");
    expect(byProject).not.toContain("Add a cache");

    const byStage = (await dashboard.get("/work?stage=Implementing")).html;
    expect(byStage).toContain("Add a cache");
    expect(byStage).not.toContain("Lib work");
    expect(byStage).toContain('<option value="Implementing" selected>');

    dashboard.h.cards.transition(other.id, "Abandoned", "no");
    expect((await dashboard.get("/work?stage=finished")).html).toContain("Lib work");
  });

  it("admits an issue, which gives it a card", async () => {
    dashboard = await startDashboard();
    await externalIssue(dashboard.h);

    const response = await dashboard.post("/work/issues/admit", {
      repo: "octo/app",
      number: "42",
      back: "/work",
    });

    expect(response.headers.get("location")).toBe("/work?notice=admitted");
    const issue = dashboard.h.intake.issues().find((item) => item.number === 42);
    expect(issue?.state).toBe("admitted");
    expect(issue?.cardId).not.toBeNull();
  });

  it("rejects an issue", async () => {
    dashboard = await startDashboard();
    await externalIssue(dashboard.h);

    await dashboard.post("/work/issues/reject", { repo: "octo/app", number: "42" });

    expect(dashboard.h.intake.issues().find((item) => item.number === 42)?.state).toBe("rejected");
  });

  it("reports a failed admission without GitHub's error text", async () => {
    dashboard = await startDashboard();
    await externalIssue(dashboard.h);
    dashboard.h.github.issue = () => Promise.reject(new Error("HTTP 502 token=ghp_secret"));

    const response = await dashboard.post("/work/issues/admit", {
      repo: "octo/app",
      number: "42",
      back: "/work",
    });
    const location = response.headers.get("location") ?? "";
    const { html } = await dashboard.get(location);

    expect(location).toBe("/work?notice=admit-failed");
    expect(html).toContain("The issue was not admitted");
    expect(html).not.toContain("ghp_secret");
  });

  it("says when there is no work", async () => {
    dashboard = await startDashboard();

    const { html } = await dashboard.get("/work");

    expect(html).toContain("No cards yet.");
    expect(html).toContain("No issue is waiting for you.");
  });

  it("shows the store error banner when the store cannot be read", async () => {
    dashboard = await startDashboard();
    await externalIssue(dashboard.h);
    dashboard.h.db.close();

    const { status, html } = await dashboard.get("/work");

    expect(status).toBe(200);
    expect(html).toContain("Hephaestus could not read its store");
    expect(html).not.toContain('action="/work/issues/admit"');
  });
});

describe("Card detail", () => {
  it("shows the stage, PR, head, worker, escalation, timeline, and the owner's actions", async () => {
    dashboard = await startDashboard();
    const card = escalatedCard(dashboard.h);

    const { status, html } = await dashboard.get(`/work/${String(card)}`);

    expect(status).toBe(200);
    expect(html).toContain("Fix &lt;the&gt; parser");
    expect(html).toContain('href="https://github.com/octo/app/pull/5"');
    expect(html).toContain(SHA.slice(0, 7));
    expect(html).toContain("w1");
    expect(html).toContain("The PR touches .github/workflows/ci.yml");
    expect(html).toContain('<ol class="timeline">');
    expect(html).toContain("work started");
    expect(html).toContain(`action="/work/${String(card)}/approve-merge"`);
    expect(html).toContain(`action="/work/${String(card)}/send-to-lead"`);
  });

  it("lists the card's threads with links to their activity", async () => {
    dashboard = await startDashboard();
    const card = runningCard(dashboard.h);

    const { html } = await dashboard.get(`/work/${String(card)}`);

    expect(html).toContain('href="/threads/w1/t-impl"');
    expect(html).toContain("Factory Codex");
    expect(html).not.toContain("/approve-merge");
    expect(html).toContain(`action="/work/${String(card)}/abandon"`);
  });

  it("offers no actions on a finished card", async () => {
    dashboard = await startDashboard();
    const card = dashboard.h.cards.create({ repo: "octo/app", issueNumber: 1, title: "Old" }).id;
    dashboard.h.cards.transition(card, "Abandoned", "not needed");

    const { html } = await dashboard.get(`/work/${String(card)}`);

    expect(html).not.toContain(`action="/work/${String(card)}/`);
  });

  it("answers 404 for a card that does not exist", async () => {
    dashboard = await startDashboard();

    expect((await dashboard.get("/work/999")).status).toBe(404);
  });

  it("shows the store error banner when the store cannot be read", async () => {
    dashboard = await startDashboard();
    const card = escalatedCard(dashboard.h);
    dashboard.h.db.close();

    const { status, html } = await dashboard.get(`/work/${String(card)}`);

    expect(status).toBe(503);
    expect(html).toContain("Hephaestus could not read its store");
  });
});

describe("Thread view", () => {
  it("shows the thread's recorded activity, escaped", async () => {
    dashboard = await startDashboard();
    const card = runningCard(dashboard.h);

    const { status, html } = await dashboard.get("/threads/w1/t-impl");

    expect(status).toBe(200);
    expect(html).toContain("Brief: add a &lt;cache&gt;");
    expect(html).toContain("npm test");
    expect(html).toContain(`href="/work/${String(card)}"`);
    expect(html).toContain("gpt-5.5");
  });

  it("says when a thread has no activity yet", async () => {
    dashboard = await startDashboard();
    dashboard.h.events.recordThread({
      environmentId: "w1",
      threadId: "t-new",
      title: "Hephaestus: review",
      providerInstanceId: "hephaestus-claude",
      model: "opus",
      configVersion: 1,
      cardId: null,
      kind: "review",
    });

    expect((await dashboard.get("/threads/w1/t-new")).html).toContain("No activity recorded yet.");
  });

  it("answers 404 for an unknown or malformed thread path", async () => {
    dashboard = await startDashboard();

    expect((await dashboard.get("/threads/w1/nope")).status).toBe(404);
    expect((await dashboard.get("/threads/w1/%E0%A4%A")).status).toBe(404);
  });
});
