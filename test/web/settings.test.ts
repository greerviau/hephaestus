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
