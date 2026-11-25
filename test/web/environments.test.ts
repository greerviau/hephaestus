import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { hashPassword, writePasswordHash } from "../../src/auth.js";
import { createDashboardServer } from "../../src/server.js";
import { openStore } from "../../src/store.js";
import type { Environments } from "../../src/t3/adapter.js";
import { environmentRoutes, linkExpiryWarnings } from "../../src/web/environments.js";
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
let configRepo: string | undefined;
const launches: LaunchOptions[] = [];

async function start(
  source: {
    environments(): Promise<Environments>;
  },
  withWorkers = false,
): Promise<{ base: string; cookie: string }> {
  db = openStore(":memory:");
  writePasswordHash(db, hashPassword(PASSWORD));
  launches.length = 0;
  configRepo = undefined;
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
    manager,
    configRepo: () => configRepo,
    setConfigRepo: (slug: string) => {
      configRepo = slug;
    },
  };
  server = createDashboardServer({
    db,
    instanceId: "test",
    routes: environmentRoutes(source, () => NOW, withWorkers ? controls : undefined),
    overview: () => linkExpiryWarnings(source, () => NOW),
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

describe("Environments page", () => {
  it("shows each environment with reachability, access and link expiry", async () => {
    const { base, cookie } = await start({ environments: () => Promise.resolve(environments()) });

    const html = await (await fetch(`${base}/environments`, { headers: { cookie } })).text();

    expect(html).toContain("worker &lt;one&gt;");
    expect(html).toContain("unreachable");
    expect(html).toContain(new Date(NOW + 5 * DAY).toISOString());
    expect(html).toContain("expires in 5 days");
  });

  it("serves the same data as JSON", async () => {
    const { base, cookie } = await start({ environments: () => Promise.resolve(environments()) });

    const body = (await (
      await fetch(`${base}/api/environments`, { headers: { cookie } })
    ).json()) as Environments;

    expect(body.environments.map((environment) => environment.environmentId)).toEqual(["w1", "w2"]);
  });

  it("says when T3 cannot be reached, without repeating upstream error text", async () => {
    const { base, cookie } = await start({
      environments: () => Promise.reject(new Error("401 body: Bearer secret-token-value")),
    });

    const response = await fetch(`${base}/environments`, { headers: { cookie } });
    const html = await response.text();

    expect(response.status).toBe(502);
    expect(html).toContain("T3 could not be reached");
    expect(html).not.toContain("secret-token-value");
    const overview = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(overview).toContain("T3 could not be reached");
    expect(overview).not.toContain("secret-token-value");
    const api = await (await fetch(`${base}/api/environments`, { headers: { cookie } })).text();
    expect(api).not.toContain("secret-token-value");
  });

  it("needs a session", async () => {
    const { base } = await start({ environments: () => Promise.resolve(environments()) });

    expect((await fetch(`${base}/environments`, { redirect: "manual" })).status).toBe(303);
    expect((await fetch(`${base}/api/environments`)).status).toBe(401);
  });
});

describe("Overview", () => {
  it("warns about a link that expires within 7 days", async () => {
    const { base, cookie } = await start({ environments: () => Promise.resolve(environments()) });

    const html = await (await fetch(`${base}/`, { headers: { cookie } })).text();

    expect(html).toContain("worker two");
    expect(html).toContain("expires in 5 days");
    expect(html).not.toContain("worker &lt;one&gt;");
  });
});

describe("link errors", () => {
  it("says a link has an error without showing T3's error text", async () => {
    const { base, cookie } = await start({ environments: () => Promise.resolve(environments()) });

    const html = await (await fetch(`${base}/environments`, { headers: { cookie } })).text();
    const api = await (await fetch(`${base}/api/environments`, { headers: { cookie } })).text();

    expect(html).not.toContain("connection refused");
    expect(api).not.toContain("connection refused");
    expect(html).toContain("last call failed");
  });
});

describe("worker setup", () => {
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

  it("marks an environment as a worker and names its next step", async () => {
    const { base, cookie } = await start(
      { environments: () => Promise.resolve(environments()) },
      true,
    );

    expect((await post(base, cookie, "/environments/w1/enable")).status).toBe(303);
    const html = await (await fetch(`${base}/environments`, { headers: { cookie } })).text();

    expect(manager?.worker("w1")).toMatchObject({ label: "worker <one>", enabled: true });
    expect(html).toContain("No config version is deployed yet.");
    expect(html).toContain("Use as a worker");
  });

  it("starts a Codex sign-in and shows the device code once the thread prints it", async () => {
    const { base, cookie } = await start(
      { environments: () => Promise.resolve(environments()) },
      true,
    );
    await post(base, cookie, "/environments/w1/enable");
    await post(base, cookie, "/environments/w1/sign-in-codex");
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
    const html = await (await fetch(`${base}/environments`, { headers: { cookie } })).text();

    expect(html).toContain("ABCD-12345");
  });

  it("saves the config repo name and refuses one that is not owner/name", async () => {
    const { base, cookie } = await start(
      { environments: () => Promise.resolve(environments()) },
      true,
    );

    expect(
      (await post(base, cookie, "/environments/config-repo", { slug: "octo/config" })).status,
    ).toBe(303);
    expect(configRepo).toBe("octo/config");
    expect(
      (await post(base, cookie, "/environments/config-repo", { slug: "not a repo" })).status,
    ).toBe(400);
  });

  it("refuses an environment T3 does not link", async () => {
    const { base, cookie } = await start(
      { environments: () => Promise.resolve(environments()) },
      true,
    );
    expect((await post(base, cookie, "/environments/nope/enable")).status).toBe(404);
  });
});
