import { afterEach, describe, expect, it } from "vitest";
import type { WorkerView } from "../../src/workers/manager.js";
import { MERGE, SHA, pr } from "../factory/harness.js";
import { PROJECT_COOKIE } from "../../src/web/shell.js";
import {
  escalatedCard,
  externalIssue,
  linked,
  runningCard,
  startDashboard,
  type Dashboard,
  type DashboardOptions,
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

function readyWorker(): WorkerView {
  return {
    ...signInWorker(),
    claude: "signed-in",
    codex: "signed-in",
    ready: true,
    blocker: undefined,
    ownerStep: false,
  };
}

/** A factory with every setup step done, so Home shows its sections and not the checklist. */
function setUp(): DashboardOptions {
  return {
    configRepo: "octo/hephaestus-config",
    hermesModel: "claude-sonnet-5",
    workers: [readyWorker()],
  };
}

/** The page as the owner sees it with the sidebar's project picker set to `repo`. */
async function getFor(running: Dashboard, repo: string): Promise<string> {
  const response = await fetch(`${running.base}/`, {
    headers: { cookie: `${running.cookie}; ${PROJECT_COOKIE}=${encodeURIComponent(repo)}` },
  });
  return response.text();
}

describe("Home", () => {
  it("counts and lists everything that needs the owner, each with its kind and actions", async () => {
    dashboard = await startDashboard({
      ...setUp(),
      environments: { environments: () => Promise.resolve(linked(3)) },
      workers: [readyWorker(), { ...signInWorker(), environmentId: "w2", label: "worker two" }],
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
    expect(html).toContain('<h1 id="page-title">Home</h1>');
    // Escalated task, external issue, proposal, expiring link, worker sign-in, notification.
    expect(html).toContain("6 things need you.");
    for (const kind of ["merge", "issue", "proposal", "worker", "notice"]) {
      expect(html).toContain(`<span class="kind">${kind}</span>`);
    }
    expect(html).toContain("#7 Fix &lt;the&gt; parser");
    expect(html).toContain("The PR touches .github/workflows/ci.yml");
    expect(html).toContain(`action="/work/${String(card)}/approve-merge"`);
    expect(html).toContain(`name="headSha" value="${SHA}"`);
    expect(html).toContain("Merge PR #5 at 1111111");
    // An action that needs typed text is a page of its own: this page reloads.
    expect(html).toContain(`href="/work/${String(card)}/lead?back=%2F"`);
    expect(html).toContain(`href="/work/${String(card)}/abandon?back=%2F"`);
    expect(html).not.toContain('type="text"');
    // An issue reads as it does on Work: its number and title link to GitHub, the repo sits underneath.
    expect(html).toContain(
      '<span class="title"><a href="https://github.com/octo/app/issues/42" target="_blank" rel="noopener noreferrer">#42 Crash on &lt;empty&gt; input<svg',
    );
    expect(html).toContain('<span class="subline">octo/app &middot; Opened by stranger outside');
    expect(html).not.toContain("octo/app#42");
    expect(html).not.toContain("Open the issue");
    expect(html).toContain('action="/work/issues/admit"');
    expect(html).toContain('action="/work/issues/reject"');
    expect(html).toContain("https://github.com/octo/app/issues/42");
    expect(html).toContain("Proposal v2: Tighten the review skill");
    expect(html).toContain('href="/proposals/2"');
    expect(html).toContain("worker one: the T3 link expires in 3 days");
    expect(html).toContain("Sign in Factory Claude.");
    expect(html).toContain('href="/workers"');
    expect(html).toContain("Reverted PR #9 in octo/app");
    expect(html).toContain("/dismiss");
    for (const old of ["/environments", "/improvement", "/pipeline", "/settings", "/messaging"]) {
      expect(html).not.toContain(`href="${old}`);
    }
  });

  it("offers a task with no merge to approve its other actions", async () => {
    dashboard = await startDashboard(setUp());
    const { h } = dashboard;
    const id = h.cards.create({ repo: "octo/app", issueNumber: 11, title: "Pick an approach" }).id;
    h.cards.transition(id, "Implementing", "work started");
    h.cards.transition(id, "Escalated", "needs a decision", {
      escalatedTo: "owner",
      reason: "Two designs fit",
    });

    const { html } = await dashboard.get("/");

    expect(html).toContain("1 thing needs you.");
    expect(html).toContain('<span class="kind">task</span>');
    expect(html).not.toContain("approve-merge");
    expect(html).toContain(`<a class="btn primary" href="/work/${String(id)}/lead?back=%2F">`);
    expect(html).toContain(`href="/work/${String(id)}/abandon?back=%2F"`);
  });

  it("shows tasks in progress with their running threads, and the latest finished ones", async () => {
    dashboard = await startDashboard(setUp());
    const { h } = dashboard;
    const running = runningCard(h);
    const waiting = h.cards.create({ repo: "octo/app", issueNumber: 9, title: "Queued work" }).id;
    h.cards.transition(waiting, "Implementing", "work started", {
      waiting: "The limit of 2 running factory threads is reached.",
    });
    const done = h.cards.create({ repo: "octo/app", issueNumber: 10, title: "Shipped work" }).id;
    h.cards.transition(done, "Abandoned", "not needed");

    const { html } = await dashboard.get("/");

    expect(html).toContain("Nothing needs you. 1 task is running and 1 is waiting.");
    expect(html).not.toContain("the T3 link expires");
    expect(html).toContain(`<a class="row" href="/work/${String(running)}">`);
    expect(html).toContain("Implement on worker one, Factory Codex");
    expect(html).toContain("The limit of 2 running factory threads is reached.");
    expect(html).toContain(`<a class="row" href="/work/${String(done)}">`);
    expect(html).toContain("#10 Shipped work");
    expect(html).toContain('<a href="/work?tab=finished">All 1 finished</a>');
    expect(html).toContain('<a href="/work">Open work</a>');
  });

  it("says when nothing needs the owner and nothing is running", async () => {
    dashboard = await startDashboard(setUp());

    const { status, html } = await dashboard.get("/");

    expect(status).toBe(200);
    expect(html).toContain("Nothing needs you. The factory asks here when it does.");
    expect(html).toContain("No tasks in progress.");
    expect(html).toContain("Finished tasks appear here");
  });

  it("narrows tasks to the chosen project and keeps factory-wide items", async () => {
    dashboard = await startDashboard(setUp());
    const { h } = dashboard;
    escalatedCard(h);
    runningCard(h);
    const other = h.cards.create({ repo: "octo/other", issueNumber: 3, title: "Elsewhere" }).id;
    h.cards.transition(other, "Implementing", "work started");
    const gone = h.cards.create({ repo: "octo/other", issueNumber: 4, title: "Dropped" }).id;
    h.cards.transition(gone, "Abandoned", "not needed");
    const asked = h.cards.create({ repo: "octo/other", issueNumber: 5, title: "Their call" }).id;
    h.cards.transition(asked, "Implementing", "work started");
    h.cards.transition(asked, "Escalated", "needs a decision", {
      escalatedTo: "owner",
      reason: "Two designs fit",
    });
    h.cards.notify("Something factory-wide happened");

    const all = (await dashboard.get("/")).html;
    expect(all).toContain("#3 Elsewhere");
    expect(all).toContain("#4 Dropped");
    expect(all).toContain("#5 Their call");
    expect(all).toContain("3 things need you.");

    const filtered = await getFor(dashboard, "octo/app");
    expect(filtered).toContain("#7 Fix &lt;the&gt; parser");
    expect(filtered).toContain("#8 Add a cache");
    expect(filtered).not.toContain("#3 Elsewhere");
    expect(filtered).not.toContain("#4 Dropped");
    expect(filtered).not.toContain("#5 Their call");
    expect(filtered).toContain("Something factory-wide happened");
    expect(filtered).toContain("2 things need you.");
    expect(filtered).toContain("Finished tasks appear here");
  });

  it("reloads itself every 10 seconds", async () => {
    dashboard = await startDashboard(setUp());

    expect((await dashboard.get("/")).html).toContain(
      '<meta http-equiv="refresh" content="10;url=/">',
    );
  });

  it("says the factory is paused and offers to resume it", async () => {
    dashboard = await startDashboard();

    const running = (await dashboard.get("/")).html;
    expect(running).toContain('action="/factory/pause"');
    expect(running).not.toContain("The factory is paused");
    const paused = await dashboard.post("/factory/pause", { back: "/" });
    expect(paused.status).toBe(303);
    expect(paused.headers.get("location")).toBe("/?notice=paused");
    expect(dashboard.h.pipeline.paused()).toBe(true);
    // The result of pausing and the standing state are one box, not two.
    for (const path of ["/?notice=paused", "/"]) {
      const html = (await dashboard.get(path)).html;
      expect(html.split("The factory is paused").length - 1).toBe(1);
      expect(html).toContain('<div class="box warn">');
      expect(html).toContain("Resume factory");
      expect(html).toContain('action="/factory/resume"');
    }

    await dashboard.post("/factory/resume", { back: "/" });
    expect(dashboard.h.pipeline.paused()).toBe(false);
  });

  it("approves a merge at the head commit, and refuses a stale one", async () => {
    dashboard = await startDashboard();
    const card = escalatedCard(dashboard.h);

    const stale = await dashboard.post(`/work/${String(card)}/approve-merge`, {
      headSha: "f".repeat(40),
      action: "merge",
      back: "/",
    });
    expect(stale.headers.get("location")).toBe("/?notice=merge-refused");
    expect(dashboard.h.cards.get(card).stage).toBe("Escalated");

    const approved = await dashboard.post(`/work/${String(card)}/approve-merge`, {
      headSha: SHA,
      action: "merge",
      back: "/",
    });
    expect(approved.headers.get("location")).toBe("/?notice=merge-approved");
    expect(dashboard.h.cards.get(card)).toMatchObject({ stage: "Merging", ownerApprovedSha: SHA });
  });

  it("sends a task to the lead and abandons one", async () => {
    dashboard = await startDashboard();
    const card = escalatedCard(dashboard.h);

    await dashboard.h.pipeline.escalateToOwner(card, "Decide on the CI change");
    const { html } = await dashboard.get("/");
    expect(html).toContain("Decide on the CI change");
    const version = String(dashboard.h.cards.get(card).version);
    await dashboard.post(`/work/${String(card)}/send-to-lead`, {
      note: "Split the CI change out",
      version,
    });
    expect(dashboard.h.cards.get(card)).toMatchObject({
      escalatedTo: "lead",
      reason: "Split the CI change out",
    });
    // The escalation's notification does not bring the card back to Needs you.
    expect(dashboard.h.cards.notifications().map((item) => item.kind)).toContain("escalation");
    expect((await dashboard.get("/")).html).not.toContain("needs you: ");

    const abandoned = await dashboard.post(`/work/${String(card)}/abandon`, {
      reason: "Not needed",
      version: String(dashboard.h.cards.get(card).version),
    });
    expect(abandoned.headers.get("location")).toBe(`/work/${String(card)}?notice=abandoned`);
    expect(dashboard.h.cards.get(card).stage).toBe("Abandoned");
  });

  it("says the PR already merged when sending its task to the lead settles the merge instead", async () => {
    dashboard = await startDashboard();
    const card = escalatedCard(dashboard.h);
    // Hephaestus merged PR 5, and the reply was lost.
    dashboard.h.github.prs.set(5, pr(5, SHA, { state: "MERGED", mergeSha: MERGE }));
    dashboard.h.github.ownMerges.add(MERGE);

    const response = await dashboard.post(`/work/${String(card)}/send-to-lead`, {
      note: "Start over",
      version: String(dashboard.h.cards.get(card).version),
      back: "/",
    });
    expect(response.headers.get("location")).toBe("/?notice=merge-validating");
    expect(dashboard.h.cards.get(card).stage).toBe("Merging");
  });

  it("shows the setup steps until each is done, then hides them", async () => {
    dashboard = await startDashboard();
    const fresh = (await dashboard.get("/")).html;
    expect(fresh).toContain('<h1 id="page-title">Set up the factory</h1>');
    expect(fresh).toContain("2 of 6 steps done.");
    expect(fresh).toContain('<ol class="setup">');
    // Projects and the deployed config are done; the first step left is the next one.
    expect(fresh.split('<li class="done">').length - 1).toBe(2);
    expect(fresh).toContain(
      '<li class="next"><div><strong>Name the config repo</strong><span class="subline">Name a private repo for config versions. Hephaestus creates it if it does not exist.</span></div><a class="btn primary" href="/config">Open config</a></li>',
    );
    expect(fresh).toContain('<a class="btn" href="/workers">Open workers</a>');
    expect(fresh).toContain('<a class="btn" href="/config/models/planning">Open models</a>');
    expect(fresh).toContain('<a href="/chat">connect a chat</a>');
    // Nothing waits and no task exists yet, so the checklist is the whole page.
    expect(fresh).not.toContain("Needs you");
    expect(fresh).not.toContain("In progress");
    await dashboard.close();

    dashboard = await startDashboard({ workers: [signInWorker()] });
    const blocked = (await dashboard.get("/")).html;
    expect(blocked).toContain("worker one: Sign in Factory Claude.");
    // A step the owner must take shows under the checklist too.
    expect(blocked).toContain("Needs you");
    await dashboard.close();

    dashboard = await startDashboard({
      configRepo: "octo/hephaestus-config",
      hermesModel: "claude-sonnet-5",
      workers: [readyWorker()],
    });
    const ready = (await dashboard.get("/")).html;
    expect(ready).not.toContain("Set up the factory");
    expect(ready).toContain('<h1 id="page-title">Home</h1>');
    await dashboard.close();

    // A routine redeploy leaves a signed-in worker not ready; its sign-in step stays done.
    dashboard = await startDashboard({
      configRepo: "octo/hephaestus-config",
      hermesModel: "claude-sonnet-5",
      workers: [{ ...readyWorker(), ready: false, blocker: "Deploying version 2." }],
    });
    expect((await dashboard.get("/")).html).not.toContain("Set up the factory");
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
    expect(html).toContain("Tasks could not be read.");
    expect(html).not.toContain("approve-merge");
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
      ...setUp(),
      environments: { environments: () => new Promise(() => undefined) },
      t3WaitMs: 20,
    });

    const { status, html } = await dashboard.get("/");

    expect(status).toBe(200);
    expect(html).toContain('<meta http-equiv="refresh" content="5;url=/">');
    expect(html).toContain("Checking T3 links...");
    expect(html).toContain("At least 0 things need you.");
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
