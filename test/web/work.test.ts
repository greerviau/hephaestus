import { afterEach, describe, expect, it } from "vitest";
import { MERGE_CONFLICT_DETAIL } from "../../src/factory/tasks.js";
import { decideMerge } from "../../src/factory/gate.js";
import { PRESETS } from "../../src/config/policy.js";
import { PROJECT_COOKIE } from "../../src/web/shell.js";
import { MERGE_STEP_REASONS, checksPassedAtGate } from "../../src/factory/pipeline.js";
import type { WorkerView } from "../../src/workers/manager.js";
import { SHA, pr, type Harness } from "../factory/harness.js";
import {
  escalatedTask,
  externalIssue,
  runningTask,
  startDashboard,
  type Dashboard,
} from "./dashboard.js";

let dashboard: Dashboard | undefined;

afterEach(async () => {
  await dashboard?.close();
  dashboard = undefined;
});

const SHA2 = "2222222222222222222222222222222222222222";
const MERGE = "3333333333333333333333333333333333333333";

/** A task whose PR 6 was reviewed and sits at the merge gate. */
function mergingTask(h: Harness, waiting: string | null = null): number {
  const id = h.tasks.create({ repo: "octo/app", issueNumber: 11, title: "Under test" }).id;
  h.tasks.transition(id, "Queued", "the lead queued the work");
  h.tasks.transition(id, "Implementing", "work started", { workerEnv: "w1" });
  h.tasks.transition(id, "Reviewing", "PR #6 at 2222222", { prNumber: 6, headSha: SHA2 });
  h.tasks.transition(id, "Merging", `approved at ${SHA2}`);
  if (waiting !== null) h.tasks.update(id, { waiting });
  return id;
}

/** A task the reviewer sent back once and a conflict sent back once, now in review again. */
function sentBackTask(h: Harness): number {
  const id = h.tasks.create({ repo: "octo/app", issueNumber: 12, title: "Twice sent back" }).id;
  h.tasks.transition(id, "Queued", "the lead queued the work");
  h.tasks.transition(id, "Implementing", "work started", {
    workerEnv: "w1",
    policy: PRESETS.standard,
  });
  h.tasks.transition(id, "Reviewing", "PR #9 at 1111111", { prNumber: 9, headSha: SHA });
  h.tasks.transition(id, "Implementing", "the reviewer asked for changes", { rounds: 1 });
  h.tasks.transition(id, "Reviewing", "PR #9 at 2222222", { headSha: SHA2 });
  h.tasks.transition(id, "Merging", `approved at ${SHA2}`);
  h.tasks.transition(id, "Implementing", MERGE_CONFLICT_DETAIL, { rounds: 2 });
  h.tasks.transition(id, "Reviewing", "PR #9 at 2222222", { headSha: SHA2 });
  return id;
}

/** A task merged by Hephaestus whose merge commit passed its checks. */
function doneTask(h: Harness): number {
  const id = mergingTask(h);
  h.tasks.recordReview({
    taskId: id,
    headSha: SHA2,
    reviewer: "codex",
    author: "claude",
    verdict: "approve",
    threadId: "t-rev",
  });
  h.tasks.transition(id, "Validating", `merged PR #6 as ${MERGE}`, {
    mergeSha: MERGE,
    expectedChecks: ["check:unit", "check:lint"],
  });
  h.tasks.transition(id, "Done", `checks passed on ${MERGE}`);
  return id;
}

const MERGE2 = "4444444444444444444444444444444444444444";

/** A task whose merge of PR 6 as MERGE is being checked on the default branch. */
function validatingTask(h: Harness): number {
  const id = mergingTask(h);
  h.tasks.transition(id, "Validating", `merged PR #6 as ${MERGE}`, {
    mergeSha: MERGE,
    expectedChecks: ["check:unit"],
  });
  return id;
}

/** What the Proof section says about the checks after the merge. */
function checksAfterMerge(html: string): string {
  const row = /Checks after the merge.*?<\/li>/s.exec(html)?.[0] ?? "";
  return (
    /<span class="st [^"]*">(?:<svg.*?<\/svg>|<span class="dot"><\/span>)?([^<]*)<\/span>/s.exec(
      row,
    )?.[1] ?? ""
  );
}

function worker(): WorkerView {
  return {
    environmentId: "w1",
    label: "worker one",
    enabled: true,
    home: "/home/w",
    deployedVersion: 1,
    deployedSha: "abc",
    instances: {},
    tasks: {},
    claude: "signed-in",
    codex: "signed-in",
    ready: true,
    blocker: undefined,
    ownerStep: false,
  };
}

async function getAs(running: Dashboard, path: string, repo: string): Promise<string> {
  const response = await fetch(`${running.base}${path}`, {
    headers: { cookie: `${running.cookie}; ${PROJECT_COOKIE}=${encodeURIComponent(repo)}` },
  });
  return response.text();
}

/** The page's main content, without the sidebar. */
function main(html: string): string {
  return html.slice(html.indexOf('<main id="main"'));
}

/** The tracker's steps as `class:name` pairs. */
function steps(html: string): string[] {
  const track = /<ol class="track"[^>]*>(.*?)<\/ol>/s.exec(html)?.[1] ?? "";
  return [
    ...track.matchAll(/<li class="([^"]*)"[^>]*>.*?<span class="name">([^<]+)<\/span>/gs),
  ].map((match) => `${match[1] ?? ""}:${match[2] ?? ""}`);
}

describe("Work", () => {
  it("opens on the tasks in progress, with tabs that count each group", async () => {
    dashboard = await startDashboard();
    const running = runningTask(dashboard.h);
    const escalated = escalatedTask(dashboard.h);
    doneTask(dashboard.h);
    await externalIssue(dashboard.h);

    const { status, html } = await dashboard.get("/work");

    expect(status).toBe(200);
    expect(html).toContain("<h1");
    expect(html).toContain('<a href="/work?tab=needs">Needs you<span class="n">2</span></a>');
    expect(html).toContain(
      '<a href="/work" aria-current="page">In progress<span class="n">1</span></a>',
    );
    expect(html).toContain('<a href="/work?tab=finished">Finished<span class="n">1</span></a>');
    expect(html).toContain('<a href="/work?tab=all">All</a>');
    expect(html).toContain(`href="/work/${String(running)}"`);
    expect(html).toContain("#8 Add a cache");
    expect(html).toContain("octo/app");
    expect(html).toContain("Implement on w1, Factory Codex");
    expect(html).not.toContain(`href="/work/${String(escalated)}"`);
    expect(html).not.toContain("Under test");
    expect(html).not.toContain("sent back");
  });

  it("links Request work to a page of its own that returns here", async () => {
    dashboard = await startDashboard();

    const { html } = await dashboard.get("/work?tab=finished");

    expect(html).toContain(
      '<a class="btn primary" href="/work/new?back=%2Fwork%3Ftab%3Dfinished">Request work</a>',
    );
    expect(html).not.toContain('action="/work/issues/file"');
  });

  it("reloads every 10 seconds at the same address, without the notice", async () => {
    dashboard = await startDashboard();

    const { html } = await dashboard.get("/work?tab=needs&notice=admitted");

    expect(html).toContain("Issue admitted");
    expect(html).toContain('<meta http-equiv="refresh" content="10;url=/work?tab=needs">');
  });

  it("says how many threads run against the limits", async () => {
    dashboard = await startDashboard();
    runningTask(dashboard.h);

    const { html } = await dashboard.get("/work");

    expect(html).toContain("1 of 4 threads running");
    expect(html).toContain("limit 2 tasks and 2 threads per worker, 40 starts per day");
    expect(html).not.toContain("No thread starts now");
  });

  it("says why no thread starts when the factory is paused", async () => {
    dashboard = await startDashboard();
    dashboard.h.pipeline.setPaused(true);

    for (const path of ["/work", "/work?view=board"]) {
      const { html } = await dashboard.get(path);
      expect(html).toContain("No thread starts now");
      expect(html).toContain("The factory is paused.");
    }
  });

  it("shows the tasks in progress as a board of the stages that hold tasks", async () => {
    dashboard = await startDashboard();
    const { h } = dashboard;
    const implementing = runningTask(h);
    const merging = mergingTask(h, "checks are running");
    const withLead = h.tasks.create({ repo: "octo/app", issueNumber: 13, title: "Stuck" }).id;
    h.tasks.transition(withLead, "Escalated", "to the lead: no PR to merge", {
      escalatedTo: "lead",
      reason: "no PR to merge",
    });
    escalatedTask(h);

    const { status, html } = await dashboard.get("/work?view=board");

    expect(status).toBe(200);
    expect(html).toContain('<a href="/work?view=board" aria-current="true">Board</a>');
    expect(html).toContain('<a href="/work">List</a>');
    expect(html).toContain('<section class="lane" aria-label="Implementing">');
    expect(html).toContain('<section class="lane" aria-label="Testing">');
    expect(html).toContain('<section class="lane" aria-label="Replanning">');
    expect(html).not.toContain('aria-label="Reviewing"');
    expect(html).toContain(`<a class="tile" href="/work/${String(implementing)}">`);
    expect(html).toContain(`<a class="tile" href="/work/${String(merging)}">`);
    expect(html).toContain("Implement on w1, Factory Codex");
    expect(html).toContain("checks are running");
    expect(html).toContain("no PR to merge");
    expect(html).toContain("No tasks in Reviewing, Merging, Verifying, or Reverting.");
    expect(html).not.toContain("Fix &lt;the&gt; parser");
    expect(html).toContain("1 of 4 threads running");
  });

  it("lists the queue in the lead's order, then the tasks waiting for the lead, then the deferred ones", async () => {
    dashboard = await startDashboard();
    const { h } = dashboard;
    h.pipeline.setPaused(true);
    const later = h.tasks.create({ repo: "octo/app", issueNumber: 20, title: "Queued later" }).id;
    const first = h.tasks.create({ repo: "octo/app", issueNumber: 21, title: "Queued first" }).id;
    const untriaged = h.tasks.create({ repo: "octo/app", issueNumber: 22, title: "Untriaged" }).id;
    const deferred = h.tasks.create({ repo: "octo/app", issueNumber: 23, title: "Deferred" }).id;
    await h.pipeline.queue(later, "brief");
    await h.pipeline.queue(first, "brief", later);
    await h.pipeline.defer(deferred, "needs <the> parser", later);
    runningTask(h);

    const { status, html } = await dashboard.get("/work?tab=queue");

    expect(status).toBe(200);
    expect(html).toContain(
      '<a href="/work?tab=queue" aria-current="page">Queue<span class="n">4</span></a>',
    );
    expect(html).toContain('<a href="/work">In progress<span class="n">1</span></a>');
    const page = main(html);
    const order = ["#21 Queued first", "#20 Queued later", "#22 Untriaged", "#23 Deferred"].map(
      (text) => page.indexOf(text),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(page).toContain('<h2>Queued<span class="n">2</span></h2>');
    expect(page).toContain('<h2>Planning<span class="n">1</span></h2>');
    expect(page).toContain('<h2>Deferred<span class="n">1</span></h2>');
    expect(page).toContain("1st in the queue");
    expect(page).toContain("2nd in the queue");
    expect(page).toContain(`Until task ${String(later)} is finished: needs &lt;the&gt; parser`);
    expect(page).not.toContain("#8 Add a cache");
    expect(page).not.toContain(`href="/work/${String(untriaged)}/abandon`);
  });

  it("says when nothing waits to start", async () => {
    dashboard = await startDashboard();
    runningTask(dashboard.h);

    const page = main((await dashboard.get("/work?tab=queue")).html);

    expect(page).toContain("No task is waiting to start.");
  });

  it("shows a queued task's place in the queue and a deferred task's reason on its page", async () => {
    dashboard = await startDashboard();
    const { h } = dashboard;
    h.pipeline.setPaused(true);
    const queued = h.tasks.create({ repo: "octo/app", issueNumber: 20, title: "Queued" }).id;
    const deferred = h.tasks.create({ repo: "octo/app", issueNumber: 21, title: "Deferred" }).id;
    await h.pipeline.queue(queued, "brief");
    await h.pipeline.defer(deferred, "wait for room");

    const queuedPage = (await dashboard.get(`/work/${String(queued)}`)).html;
    expect(steps(queuedPage).slice(0, 3)).toEqual([
      "past:Admitted",
      "now hold:Queued",
      ":Implementing",
    ]);
    expect(queuedPage).toContain("1st in the queue. The factory is paused.");
    expect(queuedPage).toContain(`href="/work/${String(queued)}/abandon`);

    const deferredPage = (await dashboard.get(`/work/${String(deferred)}`)).html;
    expect(steps(deferredPage)[0]).toBe("now hold:Admitted");
    expect(deferredPage).toContain("Deferred");
    expect(deferredPage).toContain("Until a task finishes: wait for room");

    await h.pipeline.abandon(deferred, "not needed");
    const abandonedPage = (await dashboard.get(`/work/${String(deferred)}`)).html;
    expect(abandonedPage).toContain("not needed");
    expect(abandonedPage).not.toContain("Until a task finishes");
  });

  it("keeps the board view on the tabs and the reload", async () => {
    dashboard = await startDashboard();

    const { html } = await dashboard.get("/work?view=board");

    expect(html).toContain('content="10;url=/work?view=board"');
    expect(html).toContain("No task is in progress.");
  });

  it("gives a task with no merge to approve a Send to lead button, as Home does", async () => {
    dashboard = await startDashboard();
    const { h } = dashboard;
    const id = h.tasks.create({ repo: "octo/app", issueNumber: 11, title: "Pick an approach" }).id;
    h.tasks.transition(id, "Queued", "the lead queued the work");
    h.tasks.transition(id, "Implementing", "work started");
    h.tasks.transition(id, "Escalated", "needs a decision", {
      escalatedTo: "owner",
      reason: "Two designs fit",
    });
    const back = encodeURIComponent("/work?tab=needs");

    const { html } = await dashboard.get("/work?tab=needs");

    expect(html).toContain('<span class="kind">task</span>');
    expect(html).not.toContain("approve-merge");
    expect(html).toContain(
      `<a class="btn primary" href="/work/${String(id)}/lead?back=${back}">Send to lead</a>`,
    );
    expect(html).toMatch(
      new RegExp(
        `<details class="menu"[^>]*>.*href="/work/${String(id)}/abandon\\?back=${back}">Abandon</a>`,
        "s",
      ),
    );
  });

  it("lists what needs you: escalated tasks with their actions, and issues to admit", async () => {
    dashboard = await startDashboard();
    const task = escalatedTask(dashboard.h);
    await externalIssue(dashboard.h);
    const back = "/work?tab=needs";

    const { html } = await dashboard.get(back);

    expect(html).toContain(`<a class="title" href="/work/${String(task)}">`);
    expect(html).toContain("The PR touches .github/workflows/ci.yml");
    expect(html).toContain(`action="/work/${String(task)}/approve-merge"`);
    expect(html).toContain(`Merge PR #5 at ${SHA.slice(0, 7)}`);
    expect(html).toContain(
      `href="/work/${String(task)}/lead?back=${encodeURIComponent(back)}">Send to lead</a>`,
    );
    expect(html).toContain(
      `href="/work/${String(task)}/abandon?back=${encodeURIComponent(back)}">Abandon</a>`,
    );
    expect(html).toContain("#42 Crash on &lt;empty&gt; input");
    expect(html).toContain('action="/work/issues/admit"');
    expect(html).toContain('action="/work/issues/reject"');
    expect(html).toContain(`name="back" value="${back}"`);
    expect(html).not.toContain("Add a cache");
  });

  it("folds rejected issues under the list", async () => {
    dashboard = await startDashboard();
    await externalIssue(dashboard.h);
    await dashboard.post("/work/issues/reject", { repo: "octo/app", number: "42" });

    const { html } = await dashboard.get("/work?tab=needs");

    expect(html).toContain("<summary>Rejected issues (1)</summary>");
    expect(html).toContain("No task or issue is waiting for you.");
    expect(html).not.toContain('action="/work/issues/admit"');
  });

  it("leaves a closed issue out of what needs you", async () => {
    dashboard = await startDashboard();
    await externalIssue(dashboard.h);
    const issue = dashboard.h.github.issues.get(42);
    if (issue !== undefined) issue.state = "CLOSED";
    await dashboard.h.intake.poll();

    const { html } = await dashboard.get("/work?tab=needs");

    expect(html).not.toContain("Crash on &lt;empty&gt; input");
    expect(html).toContain("No task or issue is waiting for you.");
  });

  it("lists finished tasks, and every task under All", async () => {
    dashboard = await startDashboard();
    runningTask(dashboard.h);
    const done = doneTask(dashboard.h);

    const finished = (await dashboard.get("/work?tab=finished")).html;
    expect(finished).toContain(`href="/work/${String(done)}"`);
    expect(finished).not.toContain("Add a cache");

    const all = (await dashboard.get("/work?tab=all")).html;
    expect(all).toContain("Under test");
    expect(all).toContain("Add a cache");
  });

  it("shows only the project the sidebar picker is set to", async () => {
    dashboard = await startDashboard();
    runningTask(dashboard.h);
    dashboard.h.tasks.create({ repo: "octo/lib", issueNumber: 3, title: "Lib work" });

    const all = (await dashboard.get("/work?tab=queue")).html;
    expect(all).toContain("Lib work");
    expect(all).toContain('Queue<span class="n">1</span>');
    expect(all).toContain('In progress<span class="n">1</span>');
    expect(all).not.toContain('name="stage"');

    const one = await getAs(dashboard, "/work?tab=queue", "octo/app");
    expect(one).not.toContain("Lib work");
    expect(one).toContain('Queue<span class="n">0</span>');
    expect(one).toContain('In progress<span class="n">1</span>');
  });

  it("says when there is no task yet", async () => {
    dashboard = await startDashboard();

    const { html } = await dashboard.get("/work?tab=all");

    expect(html).toContain("No tasks yet. An issue gets a task when it is admitted.");
  });

  it("shows the store error and no actions when the store cannot be read", async () => {
    dashboard = await startDashboard();
    await externalIssue(dashboard.h);
    dashboard.h.db.close();

    const { status, html } = await dashboard.get("/work?tab=needs");

    expect(status).toBe(200);
    expect(html).toContain("Hephaestus could not read its store");
    expect(html).not.toContain('action="/work/issues/admit"');
  });

  it("has no Pipeline page", async () => {
    dashboard = await startDashboard();

    expect((await dashboard.get("/pipeline")).status).toBe(404);
  });
});

describe("Issue actions", () => {
  it("admits an issue, which gives it a task", async () => {
    dashboard = await startDashboard();
    await externalIssue(dashboard.h);

    const response = await dashboard.post("/work/issues/admit", {
      repo: "octo/app",
      number: "42",
      back: "/work?tab=needs",
    });

    expect(response.headers.get("location")).toBe("/work?tab=needs&notice=admitted");
    const issue = dashboard.h.intake.issues().find((item) => item.number === 42);
    expect(issue?.state).toBe("admitted");
    expect(issue?.taskId).not.toBeNull();
    const { html } = await dashboard.get("/work?tab=needs&notice=admitted");
    expect(html).toContain("It has a task now.");
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
});

describe("Request work", () => {
  it("is a form on its own page that does not reload", async () => {
    dashboard = await startDashboard();

    const { status, html } = await dashboard.get("/work/new?back=%2Fwork%3Ftab%3Dneeds");

    expect(status).toBe(200);
    expect(html).toContain('<h1 id="page-title">Request work</h1>');
    expect(html).toContain('action="/work/issues/file"');
    expect(html).toContain('<option value="octo/app" selected>octo/app</option>');
    expect(html).toContain('name="back" value="/work?tab=needs"');
    expect(html).toContain('<a href="/work?tab=needs">Cancel</a>');
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it("preselects the project the sidebar picker is set to", async () => {
    dashboard = await startDashboard();
    const config = dashboard.store.current();
    if (config === undefined) throw new Error("no config");
    const next = dashboard.store.createVersion({
      document: {
        ...config.document,
        projects: {
          "octo/aaa": { policy: { preset: "standard", overrides: {} } },
          ...config.document.projects,
        },
      },
      author: "t",
      message: "second project",
      parentId: config.id,
    });
    dashboard.store.approve(next.id);
    dashboard.store.markDeployed(next.id);

    const html = await getAs(dashboard, "/work/new", "octo/app");

    expect(html).toContain('<option value="octo/app" selected>octo/app</option>');
    expect(html).toContain('<option value="octo/aaa">octo/aaa</option>');
  });

  it("ignores a back address that is not a local path", async () => {
    dashboard = await startDashboard();

    for (const back of ["https://evil.example/", "//evil.example", "/\\evil.example"]) {
      const { html } = await dashboard.get(`/work/new?back=${encodeURIComponent(back)}`);
      expect(html).toContain('name="back" value="/work"');
      expect(html).toContain('<a href="/work">Cancel</a>');
    }
  });

  it("files the request, which is admitted under the cap, and returns where it came from", async () => {
    dashboard = await startDashboard();

    const response = await dashboard.post("/work/issues/file", {
      repo: "octo/app",
      title: "Add a --verbose flag",
      body: "Print each step.",
      back: "/",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/?notice=issue-filed");
    const [issue] = dashboard.h.intake.issues(["admitted"]);
    expect(issue).toMatchObject({
      provenance: "factory",
      filedBy: "owner",
      title: "Add a --verbose flag",
    });
    expect(dashboard.h.tasks.list()).toHaveLength(1);
  });

  it("accepts a long request in any script", async () => {
    dashboard = await startDashboard();
    const response = await dashboard.post("/work/issues/file", {
      repo: "octo/app",
      title: "長".repeat(256),
      body: "設".repeat(10_000),
      back: "/work",
    });
    expect(response.headers.get("location")).toBe("/work?notice=issue-filed");
  });

  it("limits the details field to what the form reader takes", async () => {
    dashboard = await startDashboard();

    const { html } = await dashboard.get("/work/new");

    expect(html).toMatch(/<input type="text" id="title" name="title"[^>]*maxlength="256"/);
    expect(html).toMatch(/<textarea id="body" name="body"[^>]*maxlength="10000"/);
  });

  it("counts a line break in the details as one character, as the browser does", async () => {
    dashboard = await startDashboard();

    const response = await dashboard.post("/work/issues/file", {
      repo: "octo/app",
      title: "Lines",
      body: "x\r\n".repeat(5000),
    });

    expect(response.headers.get("location")).toBe("/work?notice=issue-filed");
  });

  it("shows details that are too long under their field and keeps what was typed", async () => {
    dashboard = await startDashboard();

    const response = await dashboard.post("/work/issues/file", {
      repo: "octo/app",
      title: "Keep the title",
      body: "x".repeat(10_001),
    });
    const html = await response.text();

    expect(response.status).toBe(422);
    expect(html).toContain('id="body-err" role="alert"');
    expect(html).toContain("The details have 10001 characters. The form takes 10000.");
    expect(html).toContain('value="Keep the title"');
    expect(html).toContain(`${"x".repeat(10_001)}</textarea>`);
    expect(dashboard.h.intake.issues()).toHaveLength(0);
  });

  it("says a request larger than the form reader takes is too long, not that it is empty", async () => {
    dashboard = await startDashboard();

    const response = await dashboard.post("/work/issues/file", {
      repo: "octo/app",
      title: "A title",
      body: "x".repeat(200_000),
      back: "/work?tab=all",
    });
    const html = await response.text();

    expect(response.status).toBe(413);
    expect(html).toContain("The request is too long");
    expect(html).not.toContain("Say what to do.");
    expect(html).toContain('<textarea id="body" name="body"');
    expect(dashboard.h.intake.issues()).toHaveLength(0);
  });

  it("shows a missing title under its field and keeps what was typed", async () => {
    dashboard = await startDashboard();

    const response = await dashboard.post("/work/issues/file", {
      repo: "octo/app",
      title: "  ",
      body: "Keep <this>",
      back: "/work?tab=all",
    });
    const html = await response.text();

    expect(response.status).toBe(422);
    expect(html).toContain('id="title-err" role="alert"');
    expect(html).toContain("Say what to do.");
    expect(html).toContain("Keep &lt;this&gt;</textarea>");
    expect(html).toContain('name="back" value="/work?tab=all"');
    expect(html).not.toContain('http-equiv="refresh"');
    expect(dashboard.h.intake.issues()).toHaveLength(0);
  });

  it("shows a title that is too long under its field", async () => {
    dashboard = await startDashboard();

    const response = await dashboard.post("/work/issues/file", {
      repo: "octo/app",
      title: "x".repeat(257),
    });
    const html = await response.text();

    expect(response.status).toBe(422);
    expect(html).toContain("GitHub allows 256 characters.");
  });

  it("shows a repo that is not a factory project under the project field", async () => {
    dashboard = await startDashboard();

    const response = await dashboard.post("/work/issues/file", {
      repo: "octo/other",
      title: "Anything",
      back: "/work",
    });
    const html = await response.text();

    expect(response.status).toBe(422);
    expect(html).toContain('id="repo-err" role="alert"');
    expect(html).toContain('value="Anything"');
  });

  it("keeps the form when GitHub refuses the issue, without GitHub's error text", async () => {
    dashboard = await startDashboard();
    dashboard.h.github.createIssue = () => Promise.reject(new Error("HTTP 502 token=ghp_secret"));

    const response = await dashboard.post("/work/issues/file", {
      repo: "octo/app",
      title: "Anything",
      back: "/work",
    });
    const html = await response.text();

    expect(response.status).toBe(502);
    expect(html).toContain("The issue was not filed");
    expect(html).toContain('value="Anything"');
    expect(html).not.toContain("ghp_secret");
  });

  it("says where to go when no project can take a request", async () => {
    dashboard = await startDashboard();
    const config = dashboard.store.current();
    if (config === undefined) throw new Error("no config");
    const next = dashboard.store.createVersion({
      document: { ...config.document, projects: {} },
      author: "t",
      message: "no projects",
      parentId: config.id,
    });
    dashboard.store.approve(next.id);
    dashboard.store.markDeployed(next.id);

    const { html } = await dashboard.get("/work/new");

    expect(html).toContain('<a href="/projects">Projects</a>');
    expect(html).not.toContain('action="/work/issues/file"');
  });
});

describe("Task page", () => {
  it("shows a task waiting for you with its reason and actions", async () => {
    dashboard = await startDashboard();
    const task = escalatedTask(dashboard.h);
    const id = String(task);

    const { status, html } = await dashboard.get(`/work/${id}`);

    expect(status).toBe(200);
    expect(html).toContain('<h1 id="page-title">#7 Fix &lt;the&gt; parser</h1>');
    expect(html).toContain(
      `<a href="/work">Work</a><span aria-hidden="true">/</span><span>Task ${id}</span>`,
    );
    expect(html).toContain("Needs your decision");
    expect(html).not.toContain("Waiting for you");
    expect(html).toContain("The PR touches .github/workflows/ci.yml");
    expect(html).toContain(`action="/work/${id}/approve-merge"`);
    expect(html).toContain(`Merge PR #5 at ${SHA.slice(0, 7)}`);
    expect(html).toContain(`href="/work/${id}/lead?back=%2Fwork%2F${id}">Send to lead</a>`);
    expect(html).toContain(
      `<a class="btn danger" href="/work/${id}/abandon?back=%2Fwork%2F${id}">Abandon</a>`,
    );
    expect(html).toContain('href="https://github.com/octo/app/pull/5"');
    expect(html).toContain('href="https://github.com/octo/app/issues/7"');
    expect(html).toContain(">#7<");
    expect(html).not.toContain("octo/app#7");
    expect(html).toContain("w1");
    expect(html).toContain('<ol class="tl">');
    expect(html).toContain("work started");
    expect(html).toContain('content="10;url=/work/');
    expect(steps(html)).toEqual([
      "past:Admitted",
      "past:Queued",
      "past:Implementing",
      "past:Reviewing",
      "now hold:Testing",
      ":Merging",
      ":Verifying",
      ":Done",
    ]);
  });

  it("folds the details an owner rarely needs, and the lead's brief", async () => {
    dashboard = await startDashboard();
    const task = runningTask(dashboard.h);
    dashboard.h.tasks.update(task, { brief: "Goal: add a <cache>.", branch: "factory/x-task-1" });

    const { html } = await dashboard.get(`/work/${String(task)}`);

    expect(html).toContain("<summary>More details</summary>");
    expect(html).toContain("factory/x-task-1");
    expect(html).toContain("Factory Codex");
    expect(html).toContain("<summary>The lead&#39;s brief</summary>");
    expect(html).toContain("Goal: add a &lt;cache&gt;.");
    expect(html).not.toContain("Review rounds");
  });

  it("lists the task's threads, and offers Abandon in a menu", async () => {
    dashboard = await startDashboard();
    const task = runningTask(dashboard.h);
    const id = String(task);

    const { html } = await dashboard.get(`/work/${id}`);

    expect(html).toContain('<a class="row" href="/threads/w1/t-impl">');
    expect(html).toContain("w1, Factory Codex, gpt-5.5");
    expect(html).toContain("Running");
    expect(html).not.toContain("/approve-merge");
    expect(html).toContain('<details class="menu"');
    expect(html).toContain(`<a href="/work/${id}/abandon?back=%2Fwork%2F${id}">Abandon</a>`);
    expect(html).not.toContain("First attempt");
    expect(html).not.toContain('class="track-note"');
    expect(html).not.toContain(">Proof<");
    expect(html).not.toContain(">Attempts<");
    expect(steps(html)).toEqual([
      "past:Admitted",
      "past:Queued",
      "now:Implementing",
      ":Reviewing",
      ":Testing",
      ":Merging",
      ":Verifying",
      ":Done",
    ]);
  });

  it("shows Testing until the gate's wait says the head's checks passed, then Merging", async () => {
    dashboard = await startDashboard();
    const task = mergingTask(dashboard.h, "checks are running");

    const testing = (await dashboard.get(`/work/${String(task)}`)).html;
    expect(steps(testing).slice(4, 6)).toEqual(["now hold:Testing", ":Merging"]);

    dashboard.h.tasks.update(task, { waiting: "letting every check register on the head commit" });
    const merging = (await dashboard.get(`/work/${String(task)}`)).html;
    expect(steps(merging).slice(4, 6)).toEqual(["past:Testing", "now hold:Merging"]);
  });

  it("marks how often a task was sent back, and lists the attempts from its history", async () => {
    dashboard = await startDashboard();
    const task = sentBackTask(dashboard.h);

    const { html } = await dashboard.get(`/work/${String(task)}`);

    expect(html).toContain('<span class="link loop" title="Sent back to Implementing 2 times">');
    expect(html).toContain('2x<span class="sr-only"> sent back</span>');
    expect(html).not.toContain('class="track-note"');
    expect(html).not.toContain("Sent back to Implementing 2 times.");
    expect(html).not.toContain("goes to the lead");
    expect(html).toContain('Attempts<span class="n">3</span>');
    expect(html).toContain("sent back 2 of 2 allowed");
    expect(html).toContain("Attempt 1");
    expect(html).toContain("the reviewer asked for changes");
    expect(html).toContain("Changes requested");
    expect(html).toContain("Attempt 2");
    expect(html).toContain(MERGE_CONFLICT_DETAIL);
    expect(html).toContain("Merge conflict");
    expect(html).toContain("Attempt 3");
    expect(html).toContain("Sent back to Implementing");
    expect(steps(html)[3]).toBe("now:Reviewing");
  });

  it("counts attempts only since the lead restarted the work", async () => {
    dashboard = await startDashboard();
    const { h } = dashboard;
    const task = sentBackTask(h);
    h.tasks.transition(task, "Escalated", "to the lead: stuck", { escalatedTo: "lead" });
    h.tasks.transition(task, "Implementing", "the lead restarted the work", { rounds: 0 });
    h.tasks.transition(task, "Reviewing", "PR #9 at 2222222");
    h.tasks.transition(task, "Implementing", "the reviewer asked for changes", { rounds: 1 });

    const { html } = await dashboard.get(`/work/${String(task)}`);

    expect(html).toContain('Attempts<span class="n">2</span>');
    expect(html).not.toContain("Attempt 3");
    expect(html).not.toContain("Merge conflict");
  });

  it("shows a done task with every step checked and the proof Hephaestus stores", async () => {
    dashboard = await startDashboard();
    const task = doneTask(dashboard.h);

    const { html } = await dashboard.get(`/work/${String(task)}`);

    expect(steps(html)).toEqual([
      "past:Admitted",
      "past:Queued",
      "past:Implementing",
      "past:Reviewing",
      "past:Testing",
      "past:Merging",
      "past:Verifying",
      "done:Done",
    ]);
    expect(html.match(/Complete: /g)).toHaveLength(8);
    expect(html).not.toContain('aria-current="step"');
    expect(html).toContain("<strong>Complete.</strong>");
    expect(html).toContain(`Merged as <code title="${MERGE}">${MERGE.slice(0, 7)}</code>`);
    expect(html).toContain("not sent back");
    expect(html).toContain(">Proof<");
    expect(html).toContain("Review by the other provider");
    expect(html).toContain("Approved");
    expect(html).toContain("Checks after the merge");
    expect(html).toContain("unit, lint");
    expect(html).toContain("Passed");
    expect(html).not.toContain(`action="/work/${String(task)}/`);
    expect(html).not.toContain("/abandon");
    expect(html).not.toContain("Evidence");
  });

  it("says a merge made outside Hephaestus was not checked", async () => {
    dashboard = await startDashboard();
    const task = mergingTask(dashboard.h);
    dashboard.h.tasks.transition(task, "Done", "merged outside Hephaestus", {
      foreignMerge: true,
      mergeSha: MERGE,
    });

    const { html } = await dashboard.get(`/work/${String(task)}`);

    expect(html).toContain("Merged outside Hephaestus");
    expect(html).not.toContain("Passed");
    expect(steps(html).at(-1)).toBe("done:Done");
  });

  it("keeps a task that reverts a failed merge at Verifying, with the checks marked failed", async () => {
    dashboard = await startDashboard();
    const task = mergingTask(dashboard.h);
    dashboard.h.tasks.transition(task, "Validating", `merged PR #6 as ${MERGE}`, {
      mergeSha: MERGE,
    });
    dashboard.h.tasks.transition(task, "Reverting", "checks failed; opened revert PR #7", {
      revertPr: 7,
      reverting: true,
    });

    const { html } = await dashboard.get(`/work/${String(task)}`);

    expect(steps(html).slice(5)).toEqual(["past:Merging", "now hold:Verifying", ":Done"]);
    expect(html).toContain("Failed");
    expect(html).toContain('href="https://github.com/octo/app/pull/7"');
  });

  it("says the checks after the merge have not started before the merge", async () => {
    dashboard = await startDashboard();
    const task = mergingTask(dashboard.h);

    expect(checksAfterMerge((await dashboard.get(`/work/${String(task)}`)).html)).toBe(
      "Not started",
    );
  });

  it("says the checks after the merge are running, then passed", async () => {
    dashboard = await startDashboard();
    const task = validatingTask(dashboard.h);

    expect(checksAfterMerge((await dashboard.get(`/work/${String(task)}`)).html)).toBe("Running");

    dashboard.h.tasks.transition(task, "Done", `checks passed on ${MERGE}`);
    expect(checksAfterMerge((await dashboard.get(`/work/${String(task)}`)).html)).toBe("Passed");
  });

  it("says the checks after the merge failed when the merge is being reverted", async () => {
    dashboard = await startDashboard();
    const task = validatingTask(dashboard.h);
    dashboard.h.tasks.transition(
      task,
      "Reverting",
      `checks failed on ${MERGE} (check:unit); opened revert PR #7`,
      { revertPr: 7, reverting: true },
    );

    expect(checksAfterMerge((await dashboard.get(`/work/${String(task)}`)).html)).toBe("Failed");
  });

  it("says the checks after the merge failed when the policy does not revert", async () => {
    dashboard = await startDashboard();
    const task = validatingTask(dashboard.h);
    const reason = `checks failed on the merge commit ${MERGE}: check:unit`;
    dashboard.h.tasks.transition(task, "Escalated", `to the owner: ${reason}`, {
      escalatedTo: "owner",
      reason,
    });

    const owner = (await dashboard.get(`/work/${String(task)}`)).html;
    expect(checksAfterMerge(owner)).toBe("Failed");

    // The lead's note replaces the reason; the failure is still on record.
    dashboard.h.github.prs.set(6, pr(6, SHA2));
    await dashboard.h.pipeline.sendToLead(task, "Fix forward");
    expect(checksAfterMerge((await dashboard.get(`/work/${String(task)}`)).html)).toBe("Failed");
  });

  it("says the checks passed after a revert and a second merge that passed", async () => {
    dashboard = await startDashboard();
    const { h } = dashboard;
    const task = validatingTask(h);
    h.tasks.transition(task, "Reverting", `checks failed on ${MERGE} (check:unit)`, {
      revertPr: 7,
      reverting: true,
    });
    // What the pipeline records once the revert PR merged; the revert PR stays on the task.
    h.tasks.transition(task, "Implementing", "revert PR #7 merged; working on the issue again", {
      prNumber: null,
      headSha: null,
      mergeSha: null,
      reverting: false,
      rounds: 0,
    });
    h.tasks.transition(task, "Reviewing", "PR #8 at 1111111", { prNumber: 8, headSha: SHA });
    h.tasks.transition(task, "Merging", `approved at ${SHA}`);
    h.tasks.transition(task, "Validating", `merged PR #8 as ${MERGE2}`, { mergeSha: MERGE2 });

    expect(h.tasks.get(task).revertPr).toBe(7);
    expect(checksAfterMerge((await dashboard.get(`/work/${String(task)}`)).html)).toBe("Running");

    h.tasks.transition(task, "Done", `checks passed on ${MERGE2}`);
    const { html } = await dashboard.get(`/work/${String(task)}`);
    expect(steps(html).at(-1)).toBe("done:Done");
    expect(checksAfterMerge(html)).toBe("Passed");
  });

  it("says the checks after a merge made outside Hephaestus were not checked", async () => {
    dashboard = await startDashboard();
    const task = mergingTask(dashboard.h);
    dashboard.h.tasks.transition(task, "Done", "merged outside Hephaestus", {
      foreignMerge: true,
      mergeSha: MERGE,
    });

    expect(checksAfterMerge((await dashboard.get(`/work/${String(task)}`)).html)).toBe(
      "Not checked",
    );
  });

  it("keeps an abandoned task at Merging when it was abandoned there", async () => {
    dashboard = await startDashboard();
    const task = mergingTask(dashboard.h, MERGE_STEP_REASONS.settling);
    await dashboard.h.pipeline.abandon(task, "The owner abandoned it: superseded");

    const { html } = await dashboard.get(`/work/${String(task)}`);

    expect(html).toContain("<strong>Stopped at Merging.</strong>");
    expect(steps(html).slice(4, 6)).toEqual(["past:Testing", "now stop:Merging"]);
  });

  it("keeps an abandoned task at Testing when its checks had not passed", async () => {
    dashboard = await startDashboard();
    const task = mergingTask(dashboard.h, "checks are running");
    await dashboard.h.pipeline.abandon(task, "The owner abandoned it: superseded");

    const { html } = await dashboard.get(`/work/${String(task)}`);

    expect(html).toContain("<strong>Stopped at Testing.</strong>");
    expect(steps(html).slice(4, 6)).toEqual(["now stop:Testing", ":Merging"]);
  });

  it("keeps a task that escalated past its checks at Merging, with the lead and abandoned", async () => {
    dashboard = await startDashboard();
    const { h } = dashboard;
    const task = mergingTask(h);
    const reason = `${MERGE_STEP_REASONS.refused} PR #6: a ruleset blocks it`;
    h.tasks.transition(task, "Escalated", `to the owner: ${reason}`, {
      escalatedTo: "owner",
      reason,
    });
    expect(steps((await dashboard.get(`/work/${String(task)}`)).html).slice(4, 6)).toEqual([
      "past:Testing",
      "now hold:Merging",
    ]);

    h.github.prs.set(6, pr(6, SHA2));
    await h.pipeline.sendToLead(task, "Ask the admin");
    expect(steps((await dashboard.get(`/work/${String(task)}`)).html).slice(4, 6)).toEqual([
      "past:Testing",
      "now hold:Merging",
    ]);

    await h.pipeline.abandon(task, "The owner abandoned it: blocked for good");
    const { html } = await dashboard.get(`/work/${String(task)}`);
    expect(html).toContain("<strong>Stopped at Merging.</strong>");
  });

  it("says what an escalated task waits on, the same way in its status, callout, and history", async () => {
    dashboard = await startDashboard();
    const { h } = dashboard;
    const task = mergingTask(h);
    h.tasks.transition(task, "Escalated", "to the lead: no PR to merge", {
      escalatedTo: "lead",
      reason: "no PR to merge",
    });

    const replanning = main((await dashboard.get(`/work/${String(task)}`)).html);
    expect(replanning).toMatch(
      /class="st t-wait">(?:(?!<\/span>).)*(?:<\/span>)?Replanning<\/span>/,
    );
    expect(replanning).toContain("<span>Replanning</span></div>");
    expect(replanning).toContain("<strong>Sent for replanning</strong>");
    expect(replanning).not.toContain("With the lead");
    expect(replanning).not.toContain("Moved to Escalated");
    expect(replanning).not.toContain("to the lead: no PR");

    await h.pipeline.escalateToOwner(task, "pick a <fix>");
    const owner = main((await dashboard.get(`/work/${String(task)}`)).html);
    expect(owner).toMatch(
      /class="st t-you">(?:(?!<\/span>).)*(?:<\/span>)?Needs your decision<\/span>/,
    );
    expect(owner).toContain("<span>Needs your decision</span></div>");
    expect(owner).toContain("<strong>Needs your decision</strong>");
    expect(owner).not.toContain("Escalated to you");
    expect(owner).not.toContain("Waiting for you");
  });

  it("names a worker by its label, on the task and on its thread", async () => {
    dashboard = await startDashboard({ workers: [worker()] });
    const task = runningTask(dashboard.h);

    const page = (await dashboard.get(`/work/${String(task)}`)).html;
    expect(page).toContain("worker one, Factory Codex, gpt-5.5");
    expect(page).toContain("<dt>Worker</dt><dd>worker one</dd>");
    expect(page).not.toContain("w1, Factory Codex");

    const thread = (await dashboard.get("/threads/w1/t-impl")).html;
    expect(thread).toContain("worker one, Factory Codex, gpt-5.5");
    expect(thread).not.toContain("w1, Factory Codex");
  });

  it("shows commit SHAs in the history in their short form, with the full value as a title", async () => {
    dashboard = await startDashboard();
    const task = doneTask(dashboard.h);

    const { html } = await dashboard.get(`/work/${String(task)}`);

    expect(html).toContain(`merged PR #6 as <code title="${MERGE}">${MERGE.slice(0, 7)}</code>`);
    expect(html).toContain(`approved at <code title="${SHA2}">${SHA2.slice(0, 7)}</code>`);
    expect(html).toContain(`checks passed on <code title="${MERGE}">${MERGE.slice(0, 7)}</code>`);
    for (const full of [MERGE, SHA2]) {
      expect(html.replaceAll(`title="${full}"`, "")).not.toContain(full);
    }
  });

  it("shows where an abandoned task stopped, and offers no actions", async () => {
    dashboard = await startDashboard();
    const task = dashboard.h.tasks.create({ repo: "octo/app", issueNumber: 1, title: "Old" }).id;
    dashboard.h.tasks.transition(task, "Queued", "the lead queued the work");
    dashboard.h.tasks.transition(task, "Implementing", "work started");
    dashboard.h.tasks.transition(task, "Abandoned", "not needed", { reason: "not needed" });

    const { html } = await dashboard.get(`/work/${String(task)}`);

    expect(html).not.toContain(`action="/work/${String(task)}/`);
    expect(html).not.toContain("/abandon");
    expect(html).toContain("<strong>Stopped at Implementing.</strong> Nothing was merged.");
    expect(html).toContain("not needed");
    expect(steps(html).slice(0, 4)).toEqual([
      "past:Admitted",
      "past:Queued",
      "now stop:Implementing",
      ":Reviewing",
    ]);
  });

  it("says why a task waits", async () => {
    dashboard = await startDashboard();
    const task = runningTask(dashboard.h);
    dashboard.h.tasks.update(task, { waiting: "The factory is paused." });

    const { html } = await dashboard.get(`/work/${String(task)}`);

    expect(html).toContain('<div class="box info">');
    expect(html).toContain("The factory is paused.");
    expect(steps(html)[2]).toBe("now hold:Implementing");
  });

  it("answers 404 for a task that does not exist", async () => {
    dashboard = await startDashboard();

    const { status, html } = await dashboard.get("/work/999");

    expect(status).toBe(404);
    expect(html).toContain("No such task");
  });

  it("shows the store error when the store cannot be read", async () => {
    dashboard = await startDashboard();
    const task = escalatedTask(dashboard.h);
    dashboard.h.db.close();

    const { status, html } = await dashboard.get(`/work/${String(task)}`);

    expect(status).toBe(503);
    expect(html).toContain("Hephaestus could not read its store");
  });
});

describe("Testing or Merging", () => {
  const base = {
    policy: PRESETS.standard,
    failedChecks: [],
    files: [],
    approvedAtHead: true,
    ownerApprovedAtHead: false,
  };
  const reason = (decision: ReturnType<typeof decideMerge>): string | null =>
    decision.action === "merge" ? null : decision.reason;

  it("reads the gate's reasons that come before the checks pass as Testing", () => {
    expect(checksPassedAtGate(null)).toBe(false);
    expect(checksPassedAtGate(reason(decideMerge({ ...base, checks: "pending" })))).toBe(false);
    expect(checksPassedAtGate(reason(decideMerge({ ...base, checks: "none" })))).toBe(false);
    expect(
      checksPassedAtGate(
        reason(
          decideMerge({
            ...base,
            policy: { ...PRESETS.standard, requiredChecks: ["unit"] },
            checks: "success",
          }),
        ),
      ),
    ).toBe(false);
    expect(
      checksPassedAtGate(
        reason(decideMerge({ ...base, checks: "failure", failedChecks: ["unit"] })),
      ),
    ).toBe(false);
  });

  it("reads the gate's reasons that come after the checks pass as Merging", () => {
    const passed = { ...base, checks: "success" as const };
    const decisions = [
      decideMerge({
        ...passed,
        policy: { ...PRESETS.standard, requireReview: true },
        approvedAtHead: false,
      }),
      decideMerge({ ...passed, filesComplete: false }),
      decideMerge({
        ...passed,
        policy: { ...PRESETS.standard, escalationPaths: [".github/**"] },
        files: [".github/workflows/ci.yml"],
      }),
      decideMerge({ ...passed, policy: { ...PRESETS.standard, ownerApprovesEveryMerge: true } }),
    ];
    for (const decision of decisions) {
      expect(decision.action).toBe("escalate");
      expect(checksPassedAtGate(reason(decision))).toBe(true);
    }
    expect(checksPassedAtGate("letting every check register on the head commit")).toBe(true);
  });

  it("recognises every reason the gate gives once the checks no longer hold the merge back", () => {
    const flags = [false, true];
    const seen = new Set<string>();
    for (const checks of ["success", "none"] as const) {
      for (const requireReview of flags) {
        for (const approvedAtHead of flags) {
          for (const filesComplete of flags) {
            for (const touches of flags) {
              for (const ownerApprovesEveryMerge of flags) {
                for (const autoMerge of flags) {
                  const decision = decideMerge({
                    ...base,
                    policy: {
                      ...PRESETS.standard,
                      allowNoChecks: true,
                      requiredChecks: [],
                      escalationPaths: [".github/**"],
                      requireReview,
                      ownerApprovesEveryMerge,
                      autoMerge,
                    },
                    checks,
                    approvedAtHead,
                    filesComplete,
                    files: touches ? [".github/workflows/ci.yml"] : [],
                  });
                  if (decision.action === "merge") continue;
                  seen.add(decision.reason);
                  expect(checksPassedAtGate(decision.reason), decision.reason).toBe(true);
                }
              }
            }
          }
        }
      }
    }
    // Every branch of the gate after its checks: review, file list, paths, and the two policy holds.
    expect(seen.size).toBe(5);
  });

  it("recognises what the merge step records after the gate lets a merge through", () => {
    for (const reason of Object.values(MERGE_STEP_REASONS)) {
      expect(checksPassedAtGate(`${reason} PR #6: detail`), reason).toBe(true);
    }
  });
});

describe("Send to lead", () => {
  it("is a form on its own page that does not reload", async () => {
    dashboard = await startDashboard();
    const task = escalatedTask(dashboard.h);
    const id = String(task);

    const { status, html } = await dashboard.get(`/work/${id}/lead?back=%2F`);

    expect(status).toBe(200);
    expect(html).toContain('<h1 id="page-title">Send to lead</h1>');
    expect(html).toContain("#7 Fix &lt;the&gt; parser");
    expect(html).toContain(`action="/work/${id}/send-to-lead"`);
    expect(html).toContain('name="back" value="/"');
    expect(html).toContain(`name="version" value="${String(dashboard.h.tasks.get(task).version)}"`);
    expect(html).toContain('<textarea id="note" name="note"');
    expect(html).toContain('<a href="/">Cancel</a>');
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it("returns to the task page by default, and ignores a back address that is not local", async () => {
    dashboard = await startDashboard();
    const task = escalatedTask(dashboard.h);
    const id = String(task);

    const { html } = await dashboard.get(`/work/${id}/lead?back=https%3A%2F%2Fevil.example`);

    expect(html).toContain(`name="back" value="/work/${id}"`);
  });

  it("shows an empty note under its field", async () => {
    dashboard = await startDashboard();
    const task = escalatedTask(dashboard.h);
    const id = String(task);

    const response = await dashboard.post(`/work/${id}/send-to-lead`, {
      note: " ",
      version: String(dashboard.h.tasks.get(task).version),
      back: "/",
    });
    const html = await response.text();

    expect(response.status).toBe(422);
    expect(html).toContain('id="note-err" role="alert"');
    expect(html).toContain('name="back" value="/"');
    expect(dashboard.h.tasks.get(task).escalatedTo).toBe("owner");
  });

  it("sends the task to the lead with the note and returns where it came from", async () => {
    dashboard = await startDashboard();
    const task = escalatedTask(dashboard.h);
    const id = String(task);

    const response = await dashboard.post(`/work/${id}/send-to-lead`, {
      note: "Split the workflow change out",
      version: String(dashboard.h.tasks.get(task).version),
      back: "/work?tab=needs",
    });

    expect(response.headers.get("location")).toBe("/work?tab=needs&notice=sent-to-lead");
    expect(dashboard.h.tasks.get(task).escalatedTo).toBe("lead");
    const { html } = await dashboard.get("/work?tab=needs&notice=sent-to-lead");
    expect(html).toContain("The lead picks the task up with your note.");
  });

  it("takes a note as long as its field allows, in any script", async () => {
    dashboard = await startDashboard();
    const task = escalatedTask(dashboard.h);

    const response = await dashboard.post(`/work/${String(task)}/send-to-lead`, {
      note: "長".repeat(2000),
      version: String(dashboard.h.tasks.get(task).version),
      back: "/",
    });

    expect(response.headers.get("location")).toBe("/?notice=sent-to-lead");
    expect(dashboard.h.tasks.get(task).escalatedTo).toBe("lead");
  });

  it("says a note larger than the form reader takes is too long, not that it is empty", async () => {
    dashboard = await startDashboard();
    const task = escalatedTask(dashboard.h);

    const response = await dashboard.post(`/work/${String(task)}/send-to-lead`, {
      note: "x".repeat(100_000),
      version: String(dashboard.h.tasks.get(task).version),
    });
    const html = await response.text();

    expect(response.status).toBe(413);
    expect(html).toContain("The note is too long. It takes 2000 characters.");
    expect(html).not.toContain("Write a note for the lead.");
    expect(dashboard.h.tasks.get(task).escalatedTo).toBe("owner");
  });

  it("says when the task is no longer waiting for you", async () => {
    dashboard = await startDashboard();
    const task = runningTask(dashboard.h);

    const { status, html } = await dashboard.get(`/work/${String(task)}/lead`);

    expect(status).toBe(200);
    expect(html).toContain("This task is not waiting for you");
    expect(html).not.toContain("<textarea");
  });

  it("answers 404 for a task that does not exist", async () => {
    dashboard = await startDashboard();

    expect((await dashboard.get("/work/999/lead")).status).toBe(404);
    expect((await dashboard.get("/work/999/abandon")).status).toBe(404);
  });
});

describe("Abandon", () => {
  it("is a form on its own page that does not reload", async () => {
    dashboard = await startDashboard();
    const task = runningTask(dashboard.h);
    const id = String(task);

    const { status, html } = await dashboard.get(`/work/${id}/abandon?back=%2Fwork`);

    expect(status).toBe(200);
    expect(html).toContain('<h1 id="page-title">Abandon task</h1>');
    expect(html).toContain("#8 Add a cache");
    expect(html).toContain("No more threads start for it.");
    expect(html).toContain(`action="/work/${id}/abandon"`);
    expect(html).toContain('name="back" value="/work"');
    expect(html).toContain('id="reason" name="reason"');
    expect(html).toContain('<button type="submit" class="danger solid">Abandon task</button>');
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it("shows an empty reason under its field", async () => {
    dashboard = await startDashboard();
    const task = runningTask(dashboard.h);
    const id = String(task);

    const response = await dashboard.post(`/work/${id}/abandon`, {
      reason: "",
      version: String(dashboard.h.tasks.get(task).version),
    });
    const html = await response.text();

    expect(response.status).toBe(422);
    expect(html).toContain('id="reason-err" role="alert"');
    expect(dashboard.h.tasks.get(task).stage).toBe("Implementing");
  });

  it("abandons the task with the reason and returns where it came from", async () => {
    dashboard = await startDashboard();
    const task = runningTask(dashboard.h);
    const id = String(task);

    const response = await dashboard.post(`/work/${id}/abandon`, {
      reason: "superseded",
      version: String(dashboard.h.tasks.get(task).version),
      back: `/work/${id}`,
    });

    expect(response.headers.get("location")).toBe(`/work/${id}?notice=abandoned`);
    expect(dashboard.h.tasks.get(task)).toMatchObject({
      stage: "Abandoned",
      reason: "The owner abandoned it: superseded",
    });
    const { html } = await dashboard.get(`/work/${id}?notice=abandoned`);
    expect(html).toContain("Task abandoned");
  });

  it("says a reason larger than the form reader takes is too long, not that it is empty", async () => {
    dashboard = await startDashboard();
    const task = runningTask(dashboard.h);

    const response = await dashboard.post(`/work/${String(task)}/abandon`, {
      reason: "x".repeat(100_000),
      version: String(dashboard.h.tasks.get(task).version),
    });
    const html = await response.text();

    expect(response.status).toBe(413);
    expect(html).toContain("The reason is too long. It takes 2000 characters.");
    expect(html).not.toContain("Say why you abandon it.");
    expect(dashboard.h.tasks.get(task).stage).toBe("Implementing");
  });

  it("refuses a form from an earlier state of the task", async () => {
    dashboard = await startDashboard();
    const task = runningTask(dashboard.h);
    const id = String(task);
    const stale = String(dashboard.h.tasks.get(task).version);
    dashboard.h.tasks.update(task, { waiting: "changed" });

    const response = await dashboard.post(`/work/${id}/abandon`, { reason: "x", version: stale });

    expect(response.headers.get("location")).toBe(`/work/${id}?notice=abandon-failed`);
    expect(dashboard.h.tasks.get(task).stage).toBe("Implementing");
  });

  it("says when the task can no longer be abandoned", async () => {
    dashboard = await startDashboard();
    const task = doneTask(dashboard.h);

    const { html } = await dashboard.get(`/work/${String(task)}/abandon`);

    expect(html).toContain("This task can no longer be abandoned");
    expect(html).not.toContain('name="reason"');
  });
});

describe("Thread transcript", () => {
  it("shows the thread's recorded activity, escaped, under its task", async () => {
    dashboard = await startDashboard();
    const task = runningTask(dashboard.h);
    const id = String(task);

    const { status, html } = await dashboard.get("/threads/w1/t-impl");

    expect(status).toBe(200);
    expect(html).toContain(
      `<a href="/work">Work</a><span aria-hidden="true">/</span><a href="/work/${id}">Task ${id}</a><span aria-hidden="true">/</span><span>Thread</span>`,
    );
    expect(html).toContain('<div class="term" tabindex="0" role="region" aria-label="Transcript">');
    expect(html).toContain('<ol class="log">');
    expect(html).toContain("Brief: add a &lt;cache&gt;");
    expect(html).toContain('<li class="tool"><span class="n">2</span>');
    expect(html).toContain("npm test");
    expect(html).toContain("in progress");
    expect(html).toContain("Running");
    expect(html).toContain("w1, Factory Codex, gpt-5.5");
    expect(html).toContain("config v1");
    expect(html).toContain('content="10;url=/threads/w1/t-impl"');
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
      taskId: null,
      kind: "review",
    });

    const { html } = await dashboard.get("/threads/w1/t-new");

    expect(html).toContain("No activity recorded yet.");
    expect(html).toContain(
      '<a href="/work">Work</a><span aria-hidden="true">/</span><span>Thread</span>',
    );
  });

  it("answers 404 for an unknown or malformed thread path", async () => {
    dashboard = await startDashboard();

    expect((await dashboard.get("/threads/w1/nope")).status).toBe(404);
    expect((await dashboard.get("/threads/w1/%E0%A4%A")).status).toBe(404);
  });
});

/** A task whose engineer had a question, handed to the owner, with PR 5 open on its branch. */
function questionTask(h: Harness): number {
  const id = h.tasks.create({ repo: "octo/app", issueNumber: 13, title: "Pick a format" }).id;
  h.tasks.transition(id, "Queued", "the lead queued the work");
  h.tasks.transition(id, "Implementing", "work started", {
    workerEnv: "w1",
    implementer: "claude",
    implementThread: "t-q",
    branch: "factory/0123abcd-task-1",
    startedAt: new Date(Date.parse("2026-11-25T11:00:00Z")).toISOString(),
    prNumber: 5,
    headSha: SHA,
  });
  h.tasks.transition(id, "Escalated", "to the owner: Which format?", {
    escalatedTo: "owner",
    reason: "Which format?",
    ownerQuestion: true,
  });
  h.github.prs.set(5, pr(5, SHA));
  return id;
}

describe("Park", () => {
  it("is offered for a task that waits on your answer, and not for a merge to approve", async () => {
    dashboard = await startDashboard();
    const question = questionTask(dashboard.h);
    const merge = escalatedTask(dashboard.h);

    const { html } = await dashboard.get("/work?tab=needs");

    expect(html).toContain(`href="/work/${String(question)}/park?back=`);
    expect(html).not.toContain(`href="/work/${String(merge)}/park?back=`);
    const page = await dashboard.get(`/work/${String(question)}`);
    expect(page.html).toContain(`href="/work/${String(question)}/park?back=`);
  });

  it("is a form on its own page, with a re-alert time that defaults to a day and an optional note", async () => {
    dashboard = await startDashboard();
    const task = questionTask(dashboard.h);
    const id = String(task);

    const { status, html } = await dashboard.get(`/work/${id}/park?back=%2Fwork%3Ftab%3Dneeds`);

    expect(status).toBe(200);
    expect(html).toContain('<h1 id="page-title">Park task</h1>');
    expect(html).toContain(`action="/work/${id}/park"`);
    expect(html).toContain(`name="version" value="${String(dashboard.h.tasks.get(task).version)}"`);
    expect(html).toMatch(/<option value="24" selected>/);
    expect(html).toContain('<option value="168"');
    expect(html).toContain('id="note" name="note"');
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it("says why a task that waits for a merge approval cannot be parked", async () => {
    dashboard = await startDashboard();
    const task = escalatedTask(dashboard.h);

    const { status, html } = await dashboard.get(`/work/${String(task)}/park`);

    expect(status).toBe(200);
    expect(html).toContain("This task cannot be parked");
    expect(html).toContain("it waits for you to approve a merge");
    expect(main(html)).not.toContain("<select");
  });

  it("parks the task, which then shows under Parked and not under Needs you or In progress", async () => {
    dashboard = await startDashboard();
    const task = questionTask(dashboard.h);
    const id = String(task);

    const response = await dashboard.post(`/work/${id}/park`, {
      hours: "4",
      note: "Asking the team",
      version: String(dashboard.h.tasks.get(task).version),
      back: "/work?tab=needs",
    });

    expect(response.headers.get("location")).toBe("/work?tab=needs&notice=parked");
    expect(dashboard.h.tasks.get(task)).toMatchObject({
      stage: "Parked",
      prNumber: 5,
      deferUntil: "2026-11-25T16:00:00.000Z",
    });
    const needs = await dashboard.get("/work?tab=needs&notice=parked");
    expect(needs.html).toContain("Task parked");
    expect(needs.html).toContain(
      '<a href="/work?tab=needs" aria-current="page">Needs you<span class="n">0</span></a>',
    );
    expect(needs.html).toContain('<a href="/work?tab=parked">Parked<span class="n">1</span></a>');
    const active = await dashboard.get("/work");
    expect(main(active.html)).not.toContain(`href="/work/${id}"`);
    const parked = await dashboard.get("/work?tab=parked");
    expect(main(parked.html)).toContain(`href="/work/${id}"`);
    expect(parked.html).toContain("Comes back to you at 2026-11-25 16:00 UTC: Which format?");
  });

  it("refuses a re-alert time it does not offer, and keeps the note", async () => {
    dashboard = await startDashboard();
    const task = questionTask(dashboard.h);

    const response = await dashboard.post(`/work/${String(task)}/park`, {
      hours: "9999",
      note: "Asking the team",
      version: String(dashboard.h.tasks.get(task).version),
    });
    const html = await response.text();

    expect(response.status).toBe(422);
    expect(html).toContain('id="hours-err" role="alert"');
    expect(html).toContain("Asking the team");
    expect(dashboard.h.tasks.get(task).stage).toBe("Escalated");
  });

  it("shows a parked task with when it comes back, Resume, and Abandon", async () => {
    dashboard = await startDashboard();
    const task = questionTask(dashboard.h);
    await dashboard.h.pipeline.park(task, { hours: 24 });
    const id = String(task);

    const { html } = await dashboard.get(`/work/${id}`);

    expect(html).toContain("Parked");
    expect(html).toContain("Comes back to you at 2026-11-26 12:00 UTC: Which format?");
    expect(html).toContain(`href="/work/${id}/unpark?back=`);
    expect(html).toContain(`href="/work/${id}/abandon?back=`);
    expect(html).toContain("factory/0123abcd-task-1");
  });

  it("resumes a parked task with your answer, and asks for one when it is empty", async () => {
    dashboard = await startDashboard();
    const task = questionTask(dashboard.h);
    await dashboard.h.pipeline.park(task, {});
    const id = String(task);
    const form = await dashboard.get(`/work/${id}/unpark`);
    expect(form.html).toContain('<h1 id="page-title">Resume task</h1>');
    expect(form.html).toContain('<textarea id="answer" name="answer"');

    const empty = await dashboard.post(`/work/${id}/unpark`, {
      answer: " ",
      version: String(dashboard.h.tasks.get(task).version),
    });
    expect(empty.status).toBe(422);
    expect(await empty.text()).toContain('id="answer-err" role="alert"');

    const response = await dashboard.post(`/work/${id}/unpark`, {
      answer: "Use JSON.",
      version: String(dashboard.h.tasks.get(task).version),
      back: `/work/${id}`,
    });

    expect(response.headers.get("location")).toBe(`/work/${id}?notice=unparked`);
    expect(dashboard.h.tasks.get(task)).toMatchObject({ stage: "Implementing", prNumber: 5 });
    expect(dashboard.h.t3.sends.at(-1)?.message).toContain("Use JSON.");
  });

  it("abandons a parked task", async () => {
    dashboard = await startDashboard();
    const task = questionTask(dashboard.h);
    await dashboard.h.pipeline.park(task, {});
    const id = String(task);

    const response = await dashboard.post(`/work/${id}/abandon`, {
      reason: "not needed",
      version: String(dashboard.h.tasks.get(task).version),
      back: `/work/${id}`,
    });

    expect(response.headers.get("location")).toBe(`/work/${id}?notice=abandoned`);
    expect(dashboard.h.tasks.get(task).stage).toBe("Abandoned");
  });
});
