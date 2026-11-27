import type { AddressInfo } from "node:net";
import { request } from "node:http";
import type { Server } from "node:http";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, writePasswordHash } from "../src/auth.js";
import {
  LOGIN_FAILURE_LIMIT,
  LOGIN_FAILURE_WINDOW_MS,
  createDashboardServer,
} from "../src/server.js";
import { openStore } from "../src/store.js";
import { layout } from "../src/web/html.js";
import { sendHtml } from "../src/web/http.js";

const PASSWORD = "correct horse battery";

let db: Database;
let server: Server;
let base: string;
let now: number;
/** How often the server read the clock; a login's first read is when it reserves its attempt. */
let clockReads: number;

beforeEach(async () => {
  db = openStore(":memory:");
  writePasswordHash(db, hashPassword(PASSWORD));
  now = 1_000_000;
  clockReads = 0;
  server = createDashboardServer({
    db,
    instanceId: "test-instance",
    now: () => {
      clockReads += 1;
      return now;
    },
    routes: [
      {
        method: "GET",
        path: /^\/$/,
        handle: ({ response }) => {
          sendHtml(response, 200, layout("Home", "<h1>Home</h1>"));
        },
      },
    ],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

function login(password: string): Promise<Response> {
  return fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }).toString(),
    redirect: "manual",
  });
}

async function sessionCookie(): Promise<string> {
  const response = await login(PASSWORD);
  const cookie = response.headers.get("set-cookie") ?? "";
  return cookie.split(";")[0] ?? "";
}

describe("dashboard without a session", () => {
  it.each(["/", "/workers", "/anything/else"])(
    "redirects page %s to the login page",
    async (path) => {
      const response = await fetch(`${base}${path}`, { redirect: "manual" });

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");
    },
  );

  it.each(["/api/session", "/api/unknown"])("rejects API route %s with 401", async (path) => {
    const response = await fetch(`${base}${path}`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects a forged session cookie", async () => {
    const response = await fetch(`${base}/api/session`, {
      headers: { cookie: "hephaestus_session=forged" },
    });

    expect(response.status).toBe(401);
  });

  it("serves the stylesheet without a session, because the login page needs it", async () => {
    const response = await fetch(`${base}/assets/app.css`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await response.text()).toContain("--accent");
  });

  it("serves the live refresh script without a session and allows only that script", async () => {
    const response = await fetch(`${base}/assets/live.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(await response.text()).toContain("data-live-seconds");
  });

  it.each([
    ["/favicon.ico", "image/x-icon"],
    ["/assets/brand/favicon-32.png", "image/png"],
    ["/assets/brand/apple-touch-icon.png", "image/png"],
    ["/assets/brand/logo-192.png", "image/png"],
  ])("serves the icon %s without a session", async (path, type) => {
    const response = await fetch(`${base}${path}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(type);
    expect(response.headers.get("cache-control")).toContain("max-age=");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("serves only the brand files", async () => {
    const response = await fetch(`${base}/assets/brand/..%2F..%2Fpackage.json`, {
      redirect: "manual",
    });

    expect(response.status).toBe(303);
  });

  it("links the icons and shows the logo on the login page", async () => {
    const html = await (await fetch(`${base}/login`)).text();

    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="any">');
    expect(html).toContain('href="/assets/brand/favicon-32.png"');
    expect(html).toContain(
      '<link rel="apple-touch-icon" href="/assets/brand/apple-touch-icon.png">',
    );
    expect(html).toContain('src="/assets/brand/logo-192.png"');
  });

  it("serves the login page with the instance id", async () => {
    const response = await fetch(`${base}/login`);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-hephaestus-instance")).toBe("test-instance");
    expect(await response.text()).toContain('name="password"');
  });
});

describe("a store that cannot be read", () => {
  it("keeps access closed and says why, with no controls", async () => {
    const cookie = await sessionCookie();
    db.close();
    const response = await fetch(`${base}/`, { headers: { cookie }, redirect: "manual" });
    const html = await response.text();
    expect(response.status).toBe(503);
    expect(html).toContain("cannot read its store");
    expect(html).not.toContain("<form");
    db = openStore(":memory:");
  });

  it("answers a sign-in with the store page, without counting it as a wrong password", async () => {
    db.close();
    for (let attempt = 0; attempt <= LOGIN_FAILURE_LIMIT; attempt += 1) {
      const response = await login(PASSWORD);
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("cannot read its store");
    }
    db = openStore(":memory:");
  });

  it("gives back only the attempt the failed sign-in reserved, not one from a later window", async () => {
    // A sign-in reserves its attempt, then stalls before sending its password.
    const { hostname, port } = new URL(base);
    const stalled = request({
      hostname,
      port,
      path: "/login",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "40" },
    });
    const answered = new Promise<number>((resolve) => {
      stalled.on("response", (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
    });
    const before = clockReads;
    stalled.write("password=");
    while (clockReads === before) await new Promise((resolve) => setTimeout(resolve, 5));

    // Its window passes, and a new one fills up.
    now += LOGIN_FAILURE_WINDOW_MS;
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
      expect((await login("wrong horse battery")).status).toBe(401);
    }

    db.close();
    stalled.end("x".repeat(31));
    expect(await answered).toBe(503);
    expect((await login(PASSWORD)).status).toBe(429);
    db = openStore(":memory:");
  });
});

describe("login", () => {
  it("rejects a wrong password without setting a cookie", async () => {
    const response = await login("wrong horse battery");

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("shows a wrong password as an error tied to the password field", async () => {
    const html = await (await login("wrong horse battery")).text();

    expect(html).toContain('<main class="login" id="main">');
    expect(html).toMatch(
      /<input id="password" name="password"[^>]* aria-describedby="password-err">/,
    );
    expect(html).toMatch(
      /<p class="err" id="password-err" role="alert"><svg.*<\/svg>Wrong password\.<\/p>/,
    );
  });

  it("shows no error before a password is sent", async () => {
    const html = await (await fetch(`${base}/login`)).text();

    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("aria-describedby");
    expect(html).toContain('<button type="submit" class="primary">Sign in</button>');
  });

  it("sets an HttpOnly, SameSite=Strict session cookie for the right password", async () => {
    const response = await login(PASSWORD);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^hephaestus_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  it("opens pages and API routes with the session, and closes them after logout", async () => {
    const cookie = await sessionCookie();

    const page = await fetch(`${base}/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Hephaestus");

    const api = await fetch(`${base}/api/session`, { headers: { cookie } });
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({ authenticated: true });

    const unknown = await fetch(`${base}/api/unknown`, { headers: { cookie } });
    expect(unknown.status).toBe(404);

    const logout = await fetch(`${base}/logout`, {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    });
    expect(logout.status).toBe(303);

    const after = await fetch(`${base}/api/session`, { headers: { cookie } });
    expect(after.status).toBe(401);
  });
});

describe("login throttling", () => {
  it(`locks out a client after ${String(LOGIN_FAILURE_LIMIT)} wrong passwords until the window passes`, async () => {
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
      expect((await login("wrong horse battery")).status).toBe(401);
    }

    const locked = await login(PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.headers.get("set-cookie")).toBeNull();

    now += LOGIN_FAILURE_WINDOW_MS;
    expect((await login(PASSWORD)).status).toBe(303);
  });

  it("checks at most the limit of wrong passwords, even when they arrive at once", async () => {
    const burst = await Promise.all(
      Array.from({ length: LOGIN_FAILURE_LIMIT * 2 }, () => login("wrong horse battery")),
    );
    let checked = burst.filter((response) => response.status === 401).length;
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT * 2; attempt += 1) {
      const response = await login("wrong horse battery");
      if (response.status === 401) checked += 1;
      else expect(response.status).toBe(429);
    }

    expect(checked).toBe(LOGIN_FAILURE_LIMIT);
    expect((await login(PASSWORD)).status).toBe(429);
  });

  it("clears the failure count after a successful login", async () => {
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT - 1; attempt += 1) {
      await login("wrong horse battery");
    }
    expect((await login(PASSWORD)).status).toBe(303);

    expect((await login("wrong horse battery")).status).toBe(401);
    expect((await login(PASSWORD)).status).toBe(303);
  });
});

describe("cross-origin requests", () => {
  it("rejects a POST whose Origin is another port on the same host", async () => {
    const cookie = await sessionCookie();

    const response = await fetch(`${base}/logout`, {
      method: "POST",
      headers: { cookie, origin: "http://127.0.0.1:9" },
      redirect: "manual",
    });

    expect(response.status).toBe(403);
    expect((await fetch(`${base}/api/session`, { headers: { cookie } })).status).toBe(200);
  });

  it("rejects a cross-origin login", async () => {
    const response = await fetch(`${base}/login`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://evil.example",
      },
      body: new URLSearchParams({ password: PASSWORD }).toString(),
      redirect: "manual",
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("accepts a POST from the dashboard's own origin", async () => {
    const cookie = await sessionCookie();

    const response = await fetch(`${base}/logout`, {
      method: "POST",
      headers: { cookie, origin: base },
      redirect: "manual",
    });

    expect(response.status).toBe(303);
  });
});
