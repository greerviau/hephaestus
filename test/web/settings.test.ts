import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, writePasswordHash } from "../../src/auth.js";
import { ConfigStore } from "../../src/config/store.js";
import { createDashboardServer } from "../../src/server.js";
import { openStore } from "../../src/store.js";
import { settingsRoutes } from "../../src/web/settings.js";
import { sampleConfig } from "../config/fixtures.js";

const PASSWORD = "correct horse battery";

let db: Database;
let store: ConfigStore;
let server: Server;
let base: string;
let cookie: string;

beforeEach(async () => {
  db = openStore(":memory:");
  writePasswordHash(db, hashPassword(PASSWORD));
  store = new ConfigStore(db);
  const first = store.createVersion({
    document: sampleConfig(),
    author: "install",
    message: "First",
  });
  store.approve(first.id);
  store.markDeployed(first.id);
  server = createDashboardServer({ db, instanceId: "test", routes: settingsRoutes(store) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const login = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: PASSWORD }).toString(),
    redirect: "manual",
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

function get(path: string, withSession = true): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: withSession ? { cookie } : {},
    redirect: "manual",
  });
}

function post(path: string, form: Record<string, string>, withSession = true): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(withSession ? { cookie } : {}),
    },
    body: new URLSearchParams(form).toString(),
    redirect: "manual",
  });
}

describe("Settings page", () => {
  it("lists versions with state, author and message", async () => {
    const response = await get("/settings");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('href="/settings/versions/1"');
    expect(html).toContain("deployed");
    expect(html).toContain("install");
    expect(html).toContain("First");
  });

  it("creates a draft version from an edit and shows its diff", async () => {
    const document = sampleConfig();
    document.roles.lead.persona = "Lead <carefully>.";

    const created = await post("/settings/versions", {
      document: JSON.stringify(document),
      message: "Tune the lead",
      parentId: "1",
    });

    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/settings/versions/2");
    expect(store.get(2)).toMatchObject({ state: "draft", author: "owner", parentId: 1 });

    const html = await (await get("/settings/versions/2")).text();
    expect(html).toContain("roles.lead.persona");
    expect(html).toContain("Lead &lt;carefully&gt;.");
    expect(html).not.toContain("Lead <carefully>.");
  });

  it("refuses an invalid edit and keeps the text for correction", async () => {
    const response = await post("/settings/versions", {
      document: '{"projects": 5}',
      message: "Broken",
      parentId: "1",
    });
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain("projects must be an object");
    expect(html).toContain("{&quot;projects&quot;: 5}");
    expect(store.count()).toBe(1);
  });

  it("keeps the submitted parent and message when it refuses an edit", async () => {
    const second = store.createVersion({
      document: sampleConfig(),
      author: "owner",
      message: "",
      parentId: 1,
    });
    store.approve(second.id);
    store.markDeployed(second.id);

    const response = await post("/settings/versions", {
      document: '{"projects": 5}',
      message: "Keep me",
      parentId: "1",
    });
    const html = await response.text();

    expect(html).toContain('name="parentId" value="1"');
    expect(html).toContain('value="Keep me"');
    expect(html).toContain("built from version 1.");
  });

  it("offers no Revert for the first version", async () => {
    const html = await (await get("/settings/versions/1")).text();

    expect(html).not.toContain("/settings/versions/1/revert");
  });

  it("approves and rejects drafts", async () => {
    const a = store.createVersion({
      document: sampleConfig(),
      author: "owner",
      message: "",
      parentId: 1,
    });
    const b = store.createVersion({
      document: sampleConfig(),
      author: "owner",
      message: "",
      parentId: 1,
    });

    expect((await post(`/settings/versions/${String(a.id)}/approve`, {})).status).toBe(303);
    expect((await post(`/settings/versions/${String(b.id)}/reject`, {})).status).toBe(303);

    expect(store.get(a.id).state).toBe("approved");
    expect(store.get(b.id).state).toBe("rejected");
  });

  it("reverts a deployed version into a new draft", async () => {
    const changed = sampleConfig();
    changed.roles.lead.persona = "Lead carefully.";
    const second = store.createVersion({
      document: changed,
      author: "improver",
      message: "",
      parentId: 1,
    });
    store.approve(second.id);
    store.markDeployed(second.id);

    const response = await post(`/settings/versions/${String(second.id)}/revert`, {});

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings/versions/3?conflicts=0");
    expect(store.get(3).document.roles.lead.persona).toBe("Lead the work.");
  });

  it("answers 409 for a transition the version's state does not allow", async () => {
    const response = await post("/settings/versions/1/approve", {});

    expect(response.status).toBe(409);
  });

  it("deploys an approved version through the deploy hook", async () => {
    const deployed: number[] = [];
    await new Promise((resolve) => server.close(resolve));
    server = createDashboardServer({
      db,
      instanceId: "test",
      routes: settingsRoutes(store, (id) => {
        deployed.push(id);
        return Promise.resolve({});
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const draft = store.createVersion({
      document: sampleConfig(),
      author: "o",
      message: "d",
      parentId: 1,
    });
    store.approve(draft.id);

    expect(await (await get(`/settings/versions/${String(draft.id)}`)).text()).toContain(
      ">Deploy<",
    );
    const response = await post(`/settings/versions/${String(draft.id)}/deploy`, {});

    expect(response.status).toBe(303);
    expect(deployed).toEqual([draft.id]);

    const next = store.createVersion({
      document: sampleConfig(),
      author: "o",
      message: "e",
      parentId: 1,
    });
    await post(`/settings/versions/${String(next.id)}/approve`, {});
    expect(deployed).toEqual([draft.id, next.id]);
  });

  it("reports a failed deploy after approval without the error text", async () => {
    await new Promise((resolve) => server.close(resolve));
    server = createDashboardServer({
      db,
      instanceId: "test",
      routes: settingsRoutes(store, () =>
        Promise.reject(
          new Error("git push failed: token ghp_secret", { cause: new Error("exit 128") }),
        ),
      ),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const draft = store.createVersion({
      document: sampleConfig(),
      author: "o",
      message: "d",
      parentId: 1,
    });

    const approved = await post(`/settings/versions/${String(draft.id)}/approve`, {});
    const location = approved.headers.get("location") ?? "";
    const page = await (await get(location)).text();
    store.createVersion({ document: sampleConfig(), author: "o", message: "e", parentId: 1 });
    const retry = await post(`/settings/versions/${String(draft.id)}/deploy`, {});
    const retryPage = await retry.text();

    expect(location).toBe(`/settings/versions/${String(draft.id)}?deploy=failed`);
    expect(page).toContain("Approved, but not deployed");
    expect(page).not.toContain("ghp_secret");
    expect(retry.status).toBe(409);
    expect(retryPage).toContain("T3 or GitHub failed");
    expect(retryPage).not.toContain("ghp_secret");
  });

  it("answers 404 for a version that does not exist", async () => {
    expect((await get("/settings/versions/99")).status).toBe(404);
    expect((await get("/api/config/versions/99")).status).toBe(404);
  });

  it("serves versions and diffs as JSON", async () => {
    const list = (await (await get("/api/config/versions")).json()) as { id: number }[];
    const one = (await (await get("/api/config/versions/1")).json()) as {
      version: { id: number };
      diff: unknown[];
    };

    expect(list.map((version) => version.id)).toEqual([1]);
    expect(one.version.id).toBe(1);
    expect(one.diff.length).toBeGreaterThan(0);
  });

  it.each([
    ["GET", "/settings"],
    ["GET", "/settings/versions/1"],
    ["POST", "/settings/versions"],
    ["POST", "/settings/versions/1/revert"],
  ])("redirects %s %s to the login page without a session", async (method, path) => {
    const response = method === "GET" ? await get(path, false) : await post(path, {}, false);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("rejects the config API without a session", async () => {
    expect((await get("/api/config/versions", false)).status).toBe(401);
  });
});

describe("large configs", () => {
  it("can save back an unchanged config near the size cap", async () => {
    const big = sampleConfig();
    big.instructions.big = "\u00e9".repeat(600_000);
    store.createVersion({ document: big, author: "owner", message: "", parentId: 1 });
    store.approve(2);
    store.markDeployed(2);

    const page = await (await get("/settings")).text();
    const start = page.indexOf('spellcheck="false">') + 19;
    const text = page.slice(start, page.indexOf("</textarea>", start));
    const unescaped = text
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'");
    const response = await post("/settings/versions", {
      document: unescaped,
      message: "Same",
      parentId: "2",
    });

    expect(response.status).toBe(303);
  });
});

describe("Factory settings form", () => {
  it("shows the factory's limits, models, and schedules", async () => {
    const html = await (await get("/settings")).text();
    expect(html).toContain('name="limits.threads" min="0" step="1" value="4"');
    expect(html).toContain('name="codex.model" value="gpt-6.2-sol"');
    expect(html).toContain('action="/settings/factory"');
  });

  it("saves changed limits, model options, and a schedule as an approved version", async () => {
    const withCron = sampleConfig();
    withCron.roles.improver.cron = [{ name: "nightly", schedule: "0 3 * * *", prompt: "Improve." }];
    const second = store.createVersion({
      document: withCron,
      author: "owner",
      message: "",
      parentId: 1,
    });
    store.approve(second.id);
    store.markDeployed(second.id);
    const html = await (await get("/settings")).text();
    expect(html).toContain('name="cron.improver.nightly" value="0 3 * * *"');

    const response = await post("/settings/factory", {
      parentId: String(second.id),
      "limits.threadsPerWorker": "1",
      "limits.threads": "2",
      "limits.startsPerDay": "10",
      autoStartMinutes: "0",
      "claude.model": "claude-opus-5-5",
      "claude.options": "",
      "codex.model": "gpt-6.2-sol",
      "codex.options": "effort=high\nfast=false",
      "setup.model": "claude-sonnet-5-5",
      "setup.options": "",
      "setup.instanceId": "claudeAgent",
      "cron.improver.nightly": "every 12h",
      deploy: "on",
    });

    expect(response.status).toBe(303);
    // Without a deploy step, the approved version's page offers the deploy.
    expect(response.headers.get("location")).toBe(`/settings/versions/${String(second.id + 1)}`);
    const saved = store.list()[0];
    expect(saved?.state).toBe("approved");
    expect(saved?.message).toBe("Change the factory settings");
    expect(saved?.document.factory.limits).toEqual({
      threadsPerWorker: 1,
      threads: 2,
      startsPerDay: 10,
    });
    expect(saved?.document.factory.autoStartMinutes).toBe(0);
    expect(saved?.document.factory.models).toEqual({
      claude: { model: "claude-opus-5-5" },
      codex: { model: "gpt-6.2-sol", options: { effort: "high", fast: false } },
    });
    expect(saved?.document.roles.improver.cron?.[0]?.schedule).toBe("every 12h");
  });

  it("refuses a bad number, a malformed option, and a stale form, and saves nothing", async () => {
    const fields = {
      parentId: "1",
      "limits.threadsPerWorker": "-1",
      "limits.threads": "4",
      "limits.startsPerDay": "40",
      autoStartMinutes: "10",
      "claude.model": "claude-sonnet-5-5",
      "claude.options": "effort",
      "codex.model": "gpt-6.2-sol",
      "setup.model": "claude-sonnet-5-5",
      "setup.instanceId": "claudeAgent",
    };
    const bad = await post("/settings/factory", fields);
    const html = await bad.text();
    expect(bad.status).toBe(400);
    expect(html).toContain("Running factory threads per worker: give a whole number of 0 or more.");
    // The form comes back with what was typed.
    expect(html).toContain('name="limits.threadsPerWorker" min="0" step="1" value="-1"');
    expect(html).toContain(">effort</textarea>");
    expect(html).toContain("write each as id=value, not effort");

    const stale = await post("/settings/factory", { ...fields, parentId: "7" });
    expect(await stale.text()).toContain("The config changed since the page was loaded.");
    expect(store.list()).toHaveLength(1);
  });

  it("keeps a string option that reads like a switch a string", async () => {
    const quoted = sampleConfig();
    quoted.factory.models.codex = { model: "gpt-6.2-sol", options: { mode: "false", fast: true } };
    const second = store.createVersion({
      document: quoted,
      author: "owner",
      message: "",
      parentId: 1,
    });
    store.approve(second.id);
    store.markDeployed(second.id);
    const html = await (await get("/settings")).text();
    expect(html).toContain("mode=&quot;false&quot;\nfast=true");

    await post("/settings/factory", {
      parentId: String(second.id),
      "limits.threadsPerWorker": "2",
      "limits.threads": "0",
      "limits.startsPerDay": "40",
      autoStartMinutes: "10",
      "claude.model": "claude-sonnet-5-5",
      "codex.model": "gpt-6.2-sol",
      "codex.options": 'mode="false"\nfast=true',
      "setup.model": "claude-sonnet-5-5",
      "setup.instanceId": "claudeAgent",
    });
    const saved = store.list()[0]?.document.factory;
    expect(saved?.models.codex.options).toEqual({ mode: "false", fast: true });
    expect(saved?.limits.threads).toBe(0);
  });
});
