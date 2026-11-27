import { afterEach, describe, expect, it, vi } from "vitest";
import { PROJECT_COOKIE } from "../../src/web/shell.js";
import { runningTask, startDashboard, type Dashboard } from "./dashboard.js";

let dashboard: Dashboard | undefined;

afterEach(async () => {
  await dashboard?.close();
  dashboard = undefined;
});

function recordCall(
  dashboard: Dashboard,
  role: string,
  tool: string,
  ok: boolean,
  at: string,
  args = '{"task_id":1}',
): void {
  dashboard.h.db
    .prepare(
      "INSERT INTO mcp_calls (role, tool, arguments, ok, result, at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(role, tool, args, ok ? 1 : 0, ok ? "{}" : '{"error":"<bad>"}', at);
}

function notify(dashboard: Dashboard, task: number, text: string, at: string): number {
  return Number(
    dashboard.h.db
      .prepare("INSERT INTO notifications (at, task_id, text) VALUES (?, ?, ?)")
      .run(at, task, text).lastInsertRowid,
  );
}

/** The page's main region, so the sidebar's own links and forms do not match. */
function main(html: string): string {
  return html.slice(html.indexOf('<main id="main"'));
}

/** Fetches a page with the sidebar's project picker set to `repo`. */
async function getFor(dashboard: Dashboard, repo: string, path: string): Promise<string> {
  const response = await fetch(`${dashboard.base}${path}`, {
    headers: { cookie: `${dashboard.cookie}; ${PROJECT_COOKIE}=${encodeURIComponent(repo)}` },
  });
  return main(await response.text());
}

describe("Activity", () => {
  it("lists task events, agent calls, and notifications, newest first", async () => {
    dashboard = await startDashboard();
    const task = runningTask(dashboard.h);
    recordCall(dashboard, "lead", "start_work", true, "2026-11-25T13:00:00.000Z");
    recordCall(dashboard, "communicator", "file_issue", false, "2026-11-25T14:00:00.000Z");
    notify(dashboard, task, "Task <1> needs you", "2026-11-25T15:00:00.000Z");

    const { status, html } = await dashboard.get("/activity");
    const page = main(html);

    expect(status).toBe(200);
    expect(page).toContain(
      `<a href="/work/${String(task)}">#8 Add a cache</a>: moved to Implementing`,
    );
    expect(page).toContain("lead called start_work");
    expect(page).toContain("communicator called file_issue");
    expect(page).toContain("Task &lt;1&gt; needs you");
    const order = [
      "Task &lt;1&gt; needs you",
      "communicator called file_issue",
      "lead called start_work",
    ];
    const positions = order.map((text) => page.indexOf(text));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(page.match(/<li class="row kinded act-row">/g)).toHaveLength(6);
    expect(page).toContain("6 shown, newest first. The page lists at most 200.");
  });

  it("shows each row's status as text, and a call's raw arguments under a fold", async () => {
    dashboard = await startDashboard();
    recordCall(dashboard, "lead", "start_work", true, "2026-11-25T13:00:00.000Z");
    recordCall(dashboard, "communicator", "file_issue", false, "2026-11-25T14:00:00.000Z");

    const page = main((await dashboard.get("/activity")).html);

    expect(page).toMatch(/<span class="st t-done">.*?OK<\/span>/);
    expect(page).toMatch(/<span class="st t-bad">.*?Failed<\/span>/);
    expect(page).toContain(
      "<summary>Arguments</summary>" +
        '<div class="fold-body"><pre class="block">{&quot;task_id&quot;:1}</pre></div>',
    );
  });

  it("offers the kinds as a segmented control and names a task a task", async () => {
    dashboard = await startDashboard();
    runningTask(dashboard.h);

    const page = main((await dashboard.get("/activity?show=tasks")).html);

    expect(page).toContain('<div class="seg" role="group" aria-label="Kind">');
    expect(page).toContain('<a href="/activity">Everything</a>');
    expect(page).toContain('<a href="/activity?show=tasks" aria-current="true">Tasks</a>');
    expect(page).toContain('<a href="/activity?show=calls">Agent calls</a>');
    expect(page).toContain('<a href="/activity?show=notifications">Notifications</a>');
    expect(page).not.toMatch(/Task events|MCP calls/);
    expect(page).not.toContain('name="role"');
  });

  it("filters agent calls to one role with a form that has an Apply button", async () => {
    dashboard = await startDashboard();
    runningTask(dashboard.h);
    recordCall(dashboard, "lead", "start_work", true, "2026-11-25T13:00:00.000Z");
    recordCall(dashboard, "communicator", "file_issue", true, "2026-11-25T14:00:00.000Z");

    const page = main((await dashboard.get("/activity?show=calls&role=lead")).html);

    expect(page).toContain("lead called start_work");
    expect(page).not.toContain("communicator called file_issue");
    expect(page).not.toContain("moved to Implementing");
    expect(page).toContain('<form class="grp" method="get" action="/activity">');
    expect(page).toContain('<input type="hidden" name="show" value="calls">');
    expect(page).toContain('<option value="lead" selected>lead</option>');
    expect(page).toContain('<button type="submit">Apply</button>');
  });

  it("keeps only the rows of the project the sidebar picker is set to", async () => {
    dashboard = await startDashboard();
    const app = runningTask(dashboard.h);
    const lib = dashboard.h.tasks.create({
      repo: "octo/lib",
      issueNumber: 3,
      title: "Lib work",
    }).id;
    notify(dashboard, app, "App notice", "2026-11-25T15:00:00.000Z");
    notify(dashboard, lib, "Lib notice", "2026-11-25T15:01:00.000Z");
    const at = "2026-11-25T13:00:00.000Z";
    recordCall(dashboard, "lead", "start_work", true, at, JSON.stringify({ task_id: app }));
    recordCall(dashboard, "lead", "escalate", true, at, JSON.stringify({ task_id: lib }));
    recordCall(
      dashboard,
      "communicator",
      "file_issue",
      true,
      at,
      '{"repo":"octo/app","title":"t"}',
    );
    recordCall(dashboard, "communicator", "list_tasks", true, at, "{}");
    recordCall(dashboard, "improver", "get_config", true, at, "not json");

    const page = await getFor(dashboard, "octo/app", "/activity");

    expect(page).toContain("#8 Add a cache</a>: moved to Implementing");
    expect(page).toContain("App notice");
    expect(page).toContain("lead called start_work");
    expect(page).toContain("communicator called file_issue");
    expect(page).not.toContain("Lib work");
    expect(page).not.toContain("Lib notice");
    expect(page).not.toContain("lead called escalate");
    expect(page).not.toContain("communicator called list_tasks");
    expect(page).not.toContain("improver called get_config");
    expect(page).not.toContain('name="project"');
  });

  it("shows a quiet project's rows however many newer rows other projects have", async () => {
    dashboard = await startDashboard();
    const app = runningTask(dashboard.h);
    notify(dashboard, app, "App notice", "2026-11-25T10:00:00.000Z");
    recordCall(dashboard, "lead", "start_work", true, "2026-11-25T10:00:00.000Z", '{"task_id":1}');
    recordCall(dashboard, "communicator", "file_issue", true, "2026-11-25T10:00:00.000Z");
    const lib = dashboard.h.tasks.create({ repo: "octo/lib", issueNumber: 3, title: "Lib" }).id;
    for (let index = 0; index < 201; index += 1) {
      dashboard.h.tasks.event(lib, "waiting", `busy ${String(index)}`);
      notify(dashboard, lib, `Lib notice ${String(index)}`, "2026-11-25T11:00:00.000Z");
      recordCall(dashboard, "lead", "escalate", true, "2026-11-25T11:00:00.000Z", '{"task_id":2}');
    }

    const page = await getFor(dashboard, "octo/app", "/activity");

    expect(page).toContain("#8 Add a cache</a>: moved to Implementing");
    expect(page).toContain("App notice");
    expect(page).toContain("lead called start_work");
    expect(page).not.toContain("Lib notice");

    const calls = main((await dashboard.get("/activity?show=calls&role=communicator")).html);
    expect(calls).toContain("communicator called file_issue");
  });

  it("still filters agent calls by the old role name, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      dashboard = await startDashboard();
      recordCall(dashboard, "communicator", "file_issue", true, "2026-11-25T10:00:00.000Z");
      recordCall(dashboard, "lead", "start_work", true, "2026-11-25T10:00:00.000Z");

      const calls = main((await dashboard.get("/activity?show=calls&role=planner")).html);

      expect(calls).toContain("communicator called file_issue");
      expect(calls).not.toContain("lead called start_work");
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/planner.*deprecated/));
    } finally {
      warn.mockRestore();
    }
  });

  it("dismisses a notification and comes back to the same view", async () => {
    dashboard = await startDashboard();
    const task = runningTask(dashboard.h);
    const id = notify(dashboard, task, "Look at this", "2026-11-25T15:00:00.000Z");

    const before = main((await dashboard.get("/activity?show=notifications")).html);

    expect(before).toMatch(/<span class="st t-you">.*?Notified you<\/span>/);
    expect(before).toContain(
      `<form class="inline" method="post" action="/notifications/${String(id)}/dismiss">` +
        '<input type="hidden" name="back" value="/activity?show=notifications">' +
        '<button type="submit">Dismiss</button></form>',
    );

    const response = await dashboard.post(`/notifications/${String(id)}/dismiss`, {
      back: "/activity?show=notifications",
    });
    const after = main((await dashboard.get(response.headers.get("location") ?? "")).html);

    expect(response.headers.get("location")).toBe("/activity?show=notifications&notice=dismissed");
    expect(after).toContain("Notification dismissed");
    expect(after).toMatch(/<span class="st t-off">.*?Dismissed<\/span>/);
    expect(after).not.toContain(">Dismiss</button>");
  });

  it("reloads itself every 10 seconds", async () => {
    dashboard = await startDashboard();

    const { html } = await dashboard.get("/activity?show=calls");

    expect(html).toContain('<meta http-equiv="refresh" content="10;url=/activity?show=calls">');
  });

  it("says when nothing has happened", async () => {
    dashboard = await startDashboard();

    expect((await dashboard.get("/activity")).html).toContain(
      "Nothing has happened yet. Task events, agent calls, and notifications appear here.",
    );
  });

  it("shows the store error banner when the store cannot be read", async () => {
    dashboard = await startDashboard();
    dashboard.h.db.close();

    const { status, html } = await dashboard.get("/activity");

    expect(status).toBe(200);
    expect(html).toContain("Hephaestus could not read its store");
  });
});
