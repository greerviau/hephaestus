import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { hashPassword, writePasswordHash } from "../../src/auth.js";
import { createDashboardServer } from "../../src/server.js";
import { openStore } from "../../src/store.js";
import type { Environments } from "../../src/t3/adapter.js";
import { workersRoutes } from "../../src/web/workers.js";
import { ConfigStore } from "../../src/config/store.js";
import { ThreadEvents } from "../../src/t3/events.js";
import { FactoryThreads } from "../../src/t3/threads.js";
import type { LaunchOptions, T3Adapter } from "../../src/t3/adapter.js";
import { WorkerManager } from "../../src/workers/manager.js";
import { sampleConfig } from "../config/fixtures.js";

const PASSWORD = "correct horse battery";
const NOW = Date.parse("2026-11-25T00:00:00Z");
const DAY = 86_400_000;

let db: Database | undefined;
let server: Server | undefined;

afterEach(async () => {
  const running = server;
  if (running) await new Promise((resolve) => running.close(resolve));
  db?.close();
});

function environments(): Environments {
  return {
    localEnvironmentId: "local",
    environments: [
      {
        environmentId: "w1",
        label: "worker <one>",
        reachable: true,
        status: "reachable",
        access: "full-access",
        expiresAt: new Date(NOW + 30 * DAY).toISOString(),
        lastCallFailed: false,
      },
      {
        environmentId: "w2",
        label: "worker two",
        reachable: false,
        status: "unreachable",
        access: "full-access",
        expiresAt: new Date(NOW + 5 * DAY).toISOString(),
        lastCallFailed: true,
      },
    ],
  };
}

let manager: WorkerManager | undefined;
const launches: LaunchOptions[] = [];

async function start(
  source: {
    environments(): Promise<Environments>;
  },
  withWorkers = false,
  options: { t3WaitMs?: number; brokenStore?: boolean } = {},
): Promise<{ base: string; cookie: string }> {
  db = openStore(":memory:");
  writePasswordHash(db, hashPassword(PASSWORD));
  launches.length = 0;
  const store = new ConfigStore(db);
  store.createVersion({ document: sampleConfig(), author: "t", message: "first" });
  const t3 = {
    launchThread: (options: LaunchOptions) => {
      launches.push(options);
      return Promise.resolve({
        threadId: `t${String(launches.length)}`,
        runId: null,
        projectId: "p",
      });
    },
  } as unknown as T3Adapter;
  const events = new ThreadEvents(db);
  manager = new WorkerManager({
    db,
    store,
    t3,
    threads: new FactoryThreads(t3, events),
    events,
    configRepo: () => undefined,
  });
  const controls = {
    manager:
      options.brokenStore === true
        ? ({
            views: () => {
              throw new Error("SQLITE_CORRUPT: database disk image is malformed");
            },
          } as unknown as WorkerManager)
        : manager,
  };
  server = createDashboardServer({
    db,
    instanceId: "test",
    routes: workersRoutes(source, () => NOW, withWorkers ? controls : undefined, options.t3WaitMs),
  });
  const running = server;
  await new Promise<void>((resolve) => running.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${String((running.address() as AddressInfo).port)}`;
  const login = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: PASSWORD }).toString(),
    redirect: "manual",
  });
  return { base, cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
}

describe("Workers page", () => {
  const source = { environments: () => Promise.resolve(environments()) };

  async function page(base: string, cookie: string, path = "/workers"): Promise<string> {
    return (await fetch(`${base}${path}`, { headers: { cookie } })).text();
  }

  it("shows each machine as a row that opens, with its T3 link state, access and link expiry", async () => {
    const { base, cookie } = await start(source);

    const html = await page(base, cookie);

    expect(html).toContain("worker &lt;one&gt;");
    expect(html.match(/<details class="xrow"/g)).toHaveLength(2);
    expect(html).toContain("Unreachable");
    expect(html).toContain("full-access");
    expect(html).toContain(new Date(NOW + 5 * DAY).toISOString());
    expect(html).toContain("Expires in 5 days");
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("reloads every 10 seconds", async () => {
    const { base, cookie } = await start(source);

    expect(await page(base, cookie)).toContain('<meta http-equiv="refresh" content="10">');
  });

  it("is gone from the old path", async () => {
    const { base, cookie } = await start(source);

    expect((await fetch(`${base}/environments`, { headers: { cookie } })).status).toBe(404);
  });

  it("opens the rows that need attention and the one the address names", async () => {
    const { base, cookie } = await start(source);

    const plain = await page(base, cookie);
    const named = await page(base, cookie, "/workers?open=w1");

    // w2's link expires within the week, so its row is open without being asked.
    expect(plain.match(/<details class="xrow" open>/g)).toHaveLength(1);
    expect(plain).toContain('<a class="title" href="/workers?open=w1">worker &lt;one&gt;</a>');
    expect(named.match(/<details class="xrow" open>/g)).toHaveLength(2);
    expect(named).toContain('<a class="title" href="/workers">worker &lt;one&gt;</a>');
  });

  it("warns in the row when the T3 link expires soon", async () => {
    const { base, cookie } = await start(source);

    expect(await page(base, cookie)).toContain("The T3 link expires in 5 days");
  });

  it("serves the same data as JSON", async () => {
    const { base, cookie } = await start(source);

    const body = (await (
      await fetch(`${base}/api/environments`, { headers: { cookie } })
    ).json()) as Environments;

    expect(body.environments.map((environment) => environment.environmentId)).toEqual(["w1", "w2"]);
  });

  it("says when T3 cannot be reached, without repeating upstream error text", async () => {
    const { base, cookie } = await start({
      environments: () => Promise.reject(new Error("401 body: Bearer secret-token-value")),
    });

    const response = await fetch(`${base}/workers`, { headers: { cookie } });
    const html = await response.text();

    expect(response.status).toBe(502);
    expect(html).toContain("T3 could not be reached");
    expect(html).toContain('<a class="btn" href="/workers">Reload</a>');
    expect(html).not.toContain("secret-token-value");
    const api = await (await fetch(`${base}/api/environments`, { headers: { cookie } })).text();
    expect(api).not.toContain("secret-token-value");
  });

  it("says when no machine is linked", async () => {
    const { base, cookie } = await start({
      environments: () => Promise.resolve({ localEnvironmentId: "local", environments: [] }),
    });

    expect(await page(base, cookie)).toContain("No machine is linked to this host's T3 yet.");
  });

  it("shows the page as loading and refreshes while T3 has not answered", async () => {
    const { base, cookie } = await start(
      { environments: () => new Promise(() => undefined) },
      false,
      { t3WaitMs: 20 },
    );

    const response = await fetch(`${base}/workers`, { headers: { cookie } });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<meta http-equiv="refresh" content="5">');
    expect(html).toContain("Asking T3 for the linked machines...");
  });

  it("shows the store error and no worker actions when workers cannot be read", async () => {
    const { base, cookie } = await start(source, true, { brokenStore: true });

    const response = await fetch(`${base}/workers`, { headers: { cookie } });
    const html = await response.text();

    expect(response.status).toBe(503);
    expect(html).toContain("Hephaestus could not read its store");
    expect(html).not.toContain("SQLITE_CORRUPT");
    expect(html).not.toContain("/workers/w1/");
  });

  it("needs a session", async () => {
    const { base } = await start(source);

    expect((await fetch(`${base}/workers`, { redirect: "manual" })).status).toBe(303);
    expect((await fetch(`${base}/api/environments`)).status).toBe(401);
  });

  it("says a link's last call failed without showing T3's error text", async () => {
    const { base, cookie } = await start(source);

    const html = await page(base, cookie);
    const api = await (await fetch(`${base}/api/environments`, { headers: { cookie } })).text();

    expect(html).not.toContain("connection refused");
    expect(api).not.toContain("connection refused");
    expect(html).toContain("last call failed");
  });
});

describe("worker setup", () => {
  const source = { environments: () => Promise.resolve(environments()) };

  async function post(
    base: string,
    cookie: string,
    path: string,
    form: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      redirect: "manual",
    });
  }

  async function page(base: string, cookie: string, path = "/workers"): Promise<string> {
    return (await fetch(`${base}${path}`, { headers: { cookie } })).text();
  }

  it("opens every row while no machine is a worker yet", async () => {
    const { base, cookie } = await start(source, true);

    const html = await page(base, cookie);

    expect(html.match(/<details class="xrow" open>/g)).toHaveLength(2);
    expect(html).toContain("Not a worker");
    expect(html).toMatch(
      /<form class="inline" method="post" action="\/workers\/w1\/enable"><button type="submit" class="primary">Use as a worker<\/button>/,
    );
  });

  it("marks a machine as a worker, returns to its open row, and names its next step", async () => {
    const { base, cookie } = await start(source, true);

    const response = await post(base, cookie, "/workers/w1/enable");
    const html = await page(base, cookie);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/workers?open=w1");
    expect(manager?.worker("w1")).toMatchObject({ label: "worker <one>", enabled: true });
    expect(html).toContain("No config version is deployed yet.");
    expect(html).toContain("Use as a worker");
    expect(html).toContain('action="/workers/w1/deploy"');
    expect(html).toContain('action="/workers/w1/check"');
  });

  it("asks before it stops using a machine as a worker", async () => {
    const { base, cookie } = await start(source, true);
    await post(base, cookie, "/workers/w1/enable");

    const html = await page(base, cookie);

    expect(html).toMatch(
      /<details class="menu"[^>]*>.*popovertarget="stop-0">Stop using as a worker<\/button>/s,
    );
    expect(html).toMatch(
      /id="stop-0" popover[^>]*><form method="post" action="\/workers\/w1\/disable">/,
    );
    expect(html).toContain("No new thread starts on it.");
    expect((await post(base, cookie, "/workers/w1/disable")).status).toBe(303);
    expect(manager?.worker("w1")).toMatchObject({ enabled: false });
  });

  it("starts a Codex sign-in and shows the device code once the thread prints it", async () => {
    const { base, cookie } = await start(source, true);
    await post(base, cookie, "/workers/w1/enable");
    await post(base, cookie, "/workers/w1/sign-in-codex");
    expect(launches.at(-1)?.message).toContain("codex login --device-auth");

    new ThreadEvents(db as Database).upsertItems("w1", "t1", [
      {
        itemId: "c",
        position: 1,
        type: "command_execution",
        status: "completed",
        text: "   https://auth.openai.com/codex/device\n   ABCD-12345",
      },
    ]);
    await manager?.tick();
    const html = await page(base, cookie);

    expect(html).toContain("Approve the Codex sign-in");
    expect(html).toContain('<span class="code-big">ABCD-12345</span>');
    expect(html).toContain(
      '<a href="https://auth.openai.com/codex/device" target="_blank" rel="noopener noreferrer">',
    );
  });

  it("explains the Claude sign-in on a page of its own that does not reload", async () => {
    const { base, cookie } = await start(source, true);
    await post(base, cookie, "/workers/w1/enable");

    const list = await page(base, cookie);
    const form = await fetch(`${base}/workers/w1/sign-in-claude?back=%2Fworkers%3Fopen%3Dw1`, {
      headers: { cookie },
    });
    const html = await form.text();

    expect(list).toContain('href="/workers/w1/sign-in-claude?back=%2Fworkers%3Fopen%3Dw1"');
    expect(form.status).toBe(200);
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).toContain("claude setup-token");
    expect(html).toContain("worker &lt;one&gt;");
    expect(html).toContain('<form method="post" action="/workers/w1/sign-in-claude">');
    expect(html).toContain('<input type="hidden" name="back" value="/workers?open=w1">');
    expect(html).toContain('<a class="btn" href="/workers?open=w1">Cancel</a>');
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("starts the Claude sign-in and returns to where the form was opened from", async () => {
    const { base, cookie } = await start(source, true);
    await post(base, cookie, "/workers/w1/enable");
    const before = launches.length;

    const response = await post(base, cookie, "/workers/w1/sign-in-claude", {
      back: "/workers?open=w1",
    });
    const outside = await post(base, cookie, "/workers/w1/sign-in-claude", {
      back: "https://evil.example/",
    });

    expect(response.headers.get("location")).toBe("/workers?open=w1");
    expect(outside.headers.get("location")).toBe("/workers?open=w1");
    expect(launches).toHaveLength(before + 1);
    expect(await page(base, cookie)).toContain("Hephaestus: sign in Factory Claude");
  });

  it("answers 404 for the Claude sign-in page of a machine T3 does not link", async () => {
    const { base, cookie } = await start(source, true);

    const response = await fetch(`${base}/workers/nope/sign-in-claude`, { headers: { cookie } });

    expect(response.status).toBe(404);
  });

  it("no longer holds the config repo form", async () => {
    const { base, cookie } = await start(source, true);

    const html = await page(base, cookie);

    expect(html).not.toContain('name="slug"');
    expect(html).not.toContain("config repo");
  });

  it("refuses a machine T3 does not link, and an action it does not know", async () => {
    const { base, cookie } = await start(source, true);

    expect((await post(base, cookie, "/workers/nope/enable")).status).toBe(404);
    expect((await post(base, cookie, "/workers/w1/explode")).status).toBe(404);
  });
});
