import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, writePasswordHash } from "../src/auth.js";
import { createDashboardServer } from "../src/server.js";
import { openStore } from "../src/store.js";

const PASSWORD = "correct horse battery";

let db: Database;
let server: Server;
let base: string;

beforeEach(async () => {
  db = openStore(":memory:");
  writePasswordHash(db, hashPassword(PASSWORD));
  server = createDashboardServer({ db });
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
  it.each(["/", "/environments", "/anything/else"])(
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

  it("serves the login page", async () => {
    const response = await fetch(`${base}/login`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('name="password"');
  });
});

describe("login", () => {
  it("rejects a wrong password without setting a cookie", async () => {
    const response = await login("wrong horse battery");

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
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
