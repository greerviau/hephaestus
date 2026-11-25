import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { hashPassword, writePasswordHash } from "../../src/auth.js";
import { createDashboardServer } from "../../src/server.js";
import { openStore } from "../../src/store.js";
import type { Environments } from "../../src/t3/adapter.js";
import { environmentRoutes, linkExpiryWarnings } from "../../src/web/environments.js";

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
        lastError: null,
      },
      {
        environmentId: "w2",
        label: "worker two",
        reachable: false,
        status: "unreachable",
        access: "full-access",
        expiresAt: new Date(NOW + 5 * DAY).toISOString(),
        lastError: "connection refused",
      },
    ],
  };
}

async function start(source: {
  environments(): Promise<Environments>;
}): Promise<{ base: string; cookie: string }> {
  db = openStore(":memory:");
  writePasswordHash(db, hashPassword(PASSWORD));
  server = createDashboardServer({
    db,
    instanceId: "test",
    routes: environmentRoutes(source, () => NOW),
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
    expect(html).toContain("connection refused");
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
