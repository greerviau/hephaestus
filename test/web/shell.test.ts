import { afterEach, describe, expect, it } from "vitest";
import type { WorkerView } from "../../src/workers/manager.js";
import { PROJECT_COOKIE } from "../../src/web/shell.js";
import { sampleConfig } from "../config/fixtures.js";
import { escalatedTask, externalIssue, startDashboard, type Dashboard } from "./dashboard.js";

let dashboard: Dashboard | undefined;

afterEach(async () => {
  await dashboard?.close();
  dashboard = undefined;
});

/** Deploys a config with a second project, so the picker has a choice to make. */
function addProject(running: Dashboard, repo: string): void {
  const document = sampleConfig();
  document.projects[repo] = { policy: { preset: "standard", overrides: {} } };
  const version = running.store.createVersion({
    document,
    author: "t",
    message: "second",
    parentId: running.store.list()[0]?.id ?? 1,
  });
  running.store.approve(version.id);
  running.store.markDeployed(version.id);
}

function withProject(running: Dashboard, repo: string): { cookie: string } {
  return { cookie: `${running.cookie}; ${PROJECT_COOKIE}=${encodeURIComponent(repo)}` };
}

async function page(running: Dashboard, path: string, repo?: string): Promise<string> {
  const response = await fetch(`${running.base}${path}`, {
    headers: repo === undefined ? { cookie: running.cookie } : withProject(running, repo),
  });
  return response.text();
}

/** The project the sidebar picker shows as chosen for a request with these cookies, or undefined for all projects. */
async function picked(running: Dashboard, cookies: string): Promise<string | undefined> {
  const response = await fetch(`${running.base}/activity`, {
    headers: { cookie: `${running.cookie}; ${cookies}` },
  });
  const form = /<form class="scope".*?<\/form>/s.exec(await response.text())?.[0] ?? "";
  return /<option value="([^"]+)" selected>/.exec(form)?.[1];
}

function ownerStepWorker(): WorkerView {
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

describe("the page shell", () => {
  it("counts on Home what needs the owner, and on Proposals the drafts that wait", async () => {
    dashboard = await startDashboard({ workers: [ownerStepWorker()] });
    const { h, store } = dashboard;
    const task = escalatedTask(h);
    await externalIssue(h);
    h.tasks.notify("Reverted PR #9 in octo/app", task);
    store.createVersion({
      document: sampleConfig(),
      author: "improver",
      message: "Tighten the brief",
      parentId: store.list()[0]?.id ?? 1,
    });

    const html = await page(dashboard, "/activity");

    // An escalated task, an outside issue, a proposal, a worker's step, and a notification.
    expect(html).toContain('<span class="count">5<span class="sr-only"> need you</span></span>');
    expect(html).toContain('<span class="count">1<span class="sr-only"> waiting</span></span>');
  });

  it("counts every project on Home whatever the picker says", async () => {
    dashboard = await startDashboard();
    addProject(dashboard, "octo/site");
    escalatedTask(dashboard.h);

    const html = await page(dashboard, "/activity", "octo/site");

    expect(html).toContain('<option value="octo/site" selected>site</option>');
    expect(html).toContain('<span class="count">1<span class="sr-only"> need you</span></span>');
  });

  it("offers the factory's projects in the picker, returning to the page it is on", async () => {
    dashboard = await startDashboard();
    addProject(dashboard, "octo/site");

    const html = await page(dashboard, "/work?tab=finished&notice=paused");

    const form = /<form class="scope".*?<\/form>/s.exec(html)?.[0] ?? "";
    expect(form).toContain('<input type="hidden" name="back" value="/work?tab=finished">');
    expect(form).toContain('<option value="">All projects</option>');
    expect(form).toContain('<option value="octo/app">app</option>');
    expect(form).toContain('<option value="octo/site">site</option>');
    expect(form).not.toContain("selected");
  });

  it("serves the script that applies a picked project at once", async () => {
    dashboard = await startDashboard();

    const response = await fetch(`${dashboard.base}/assets/project-filter.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(await response.text()).toContain("data-submit-on-change");
  });

  it("pauses from the sidebar of any page and comes back to it", async () => {
    dashboard = await startDashboard();

    const before = await page(dashboard, "/activity");
    expect(before).toContain('<button type="button" popovertarget="pause-dialog">Pause</button>');
    expect(before).toMatch(
      /<form method="post" action="\/factory\/pause"><input type="hidden" name="back" value="\/activity">/,
    );
    const paused = await dashboard.post("/factory/pause", { back: "/activity" });
    expect(paused.headers.get("location")).toBe("/activity?notice=paused");

    const after = await page(dashboard, "/activity");
    expect(after).toContain("Paused</span>");
    expect(after).toContain('action="/factory/resume"');
    expect(after).not.toContain("pause-dialog");
  });

  it("turns the pause control off when the store cannot be read", async () => {
    dashboard = await startDashboard();
    dashboard.h.db.close();

    const html = await page(dashboard, "/activity");

    expect(html).toContain('<button type="button" disabled>Pause</button>');
    expect(html).not.toContain('class="scope"');
  });

  it("wraps a page that does not exist in the same shell", async () => {
    dashboard = await startDashboard();

    const { status, html } = await dashboard.get("/no-such-page");

    expect(status).toBe(404);
    expect(html).toContain('<form class="scope"');
    expect(html).toContain('popovertarget="pause-dialog"');
    expect(html).not.toContain("Use the tabs above");
  });

  it.each(["/", "/work", "/activity", "/analytics", "/proposals", "/projects"])(
    "gives %s the picker and the pause control",
    async (path) => {
      dashboard = await startDashboard();

      const html = await page(dashboard, path);

      expect(html).toContain('<form class="scope"');
      expect(html).toContain('popovertarget="pause-dialog"');
    },
  );
});

describe("the project filter", () => {
  it("remembers the chosen project in a cookie and returns to the page", async () => {
    dashboard = await startDashboard();

    const response = await dashboard.post("/project-filter", {
      project: "octo/app",
      back: "/work?tab=finished",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/work?tab=finished");
    expect(response.headers.get("set-cookie")).toBe(
      `${PROJECT_COOKIE}=octo%2Fapp; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
    );
  });

  it("clears the cookie for all projects", async () => {
    dashboard = await startDashboard();

    const response = await dashboard.post("/project-filter", { project: "", back: "/activity" });

    expect(response.headers.get("location")).toBe("/activity");
    expect(response.headers.get("set-cookie")).toBe(
      `${PROJECT_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    );
  });

  it("clears the cookie for a repo that is not a factory project", async () => {
    dashboard = await startDashboard();

    const response = await dashboard.post("/project-filter", { project: "evil/repo", back: "/" });

    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it.each(["https://evil.example/", "//evil.example", "/\\evil.example", "work"])(
    "returns to Home instead of %s",
    async (back) => {
      dashboard = await startDashboard();

      const response = await dashboard.post("/project-filter", { project: "octo/app", back });

      expect(response.headers.get("location")).toBe("/");
    },
  );

  it("returns to Home when the form names no page", async () => {
    dashboard = await startDashboard();

    const response = await dashboard.post("/project-filter", { project: "octo/app" });

    expect(response.headers.get("location")).toBe("/");
  });

  it("refuses a request from another origin", async () => {
    dashboard = await startDashboard();

    const response = await fetch(`${dashboard.base}/project-filter`, {
      method: "POST",
      headers: {
        cookie: dashboard.cookie,
        origin: "http://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "project=octo%2Fapp",
      redirect: "manual",
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("needs a session", async () => {
    dashboard = await startDashboard();

    const response = await fetch(`${dashboard.base}/project-filter`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "project=octo%2Fapp",
      redirect: "manual",
    });

    expect(response.headers.get("location")).toBe("/login");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("reads the selection back from the cookie", async () => {
    dashboard = await startDashboard();

    expect(await picked(dashboard, `a=b; ${PROJECT_COOKIE}=octo%2Fapp; c=d`)).toBe("octo/app");
    expect(await picked(dashboard, "a=b")).toBeUndefined();
    expect(await picked(dashboard, `${PROJECT_COOKIE}=`)).toBeUndefined();
  });

  it("ignores a cookie naming a repo that is no longer a factory project", async () => {
    dashboard = await startDashboard();
    addProject(dashboard, "octo/site");
    const cookie = `${PROJECT_COOKIE}=octo%2Fsite`;
    expect(await picked(dashboard, cookie)).toBe("octo/site");

    const without = dashboard.store.createVersion({
      document: sampleConfig(),
      author: "t",
      message: "remove site",
      parentId: dashboard.store.list()[0]?.id ?? 1,
    });
    dashboard.store.approve(without.id);
    dashboard.store.markDeployed(without.id);

    expect(await picked(dashboard, cookie)).toBeUndefined();
  });

  it("ignores a cookie that does not decode", async () => {
    dashboard = await startDashboard();

    expect(await picked(dashboard, `${PROJECT_COOKIE}=%E0%A4%A`)).toBeUndefined();
  });
});
