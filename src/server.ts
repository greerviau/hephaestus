import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Database } from "better-sqlite3";
import { SESSION_TTL_MS, Sessions, readPasswordHash, verifyPassword } from "./auth.js";
import { escapeHtml, layout, page } from "./web/html.js";
import { HTML, readBody, redirect, send, sendHtml, sendJson, type Route } from "./web/http.js";

export const SESSION_COOKIE = "hephaestus_session";
export const INSTANCE_HEADER = "x-hephaestus-instance";
/** Wrong passwords a client may send within the window before it is locked out. */
export const LOGIN_FAILURE_LIMIT = 10;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
/** Password checks that may run at once; more get 429 so scrypt cannot starve the server. */
const MAX_CONCURRENT_LOGINS = 4;
const MAX_LOGIN_FORM_BYTES = 4096;

export interface DashboardOptions {
  db: Database;
  /** Sent with every response, so install can confirm its own dashboard answers on the port. */
  instanceId: string;
  /** Pages and API routes added by feature modules. All of them require a session. */
  routes?: Route[];
  now?: () => number;
}

interface Failures {
  /** Wrong passwords in the window, plus checks still running for this client. */
  count: number;
  since: number;
}

/**
 * The dashboard. Every route except the login page requires a session: pages
 * redirect to /login and API routes answer 401.
 */
export function createDashboardServer({
  db,
  instanceId,
  routes = [],
  now = Date.now,
}: DashboardOptions): Server {
  const sessions = new Sessions(db, now);
  const failures = new Map<string, Failures>();
  let loginsInFlight = 0;

  return createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      console.error("dashboard request failed", error);
      if (!response.headersSent)
        send(response, 500, "text/plain; charset=utf-8", "Internal error\n");
      else response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = request.method ?? "GET";
    response.setHeader(INSTANCE_HEADER, instanceId);

    if (method !== "GET" && method !== "HEAD" && !sameOrigin(request)) {
      send(response, 403, "text/plain; charset=utf-8", "Cross-origin request refused\n");
      return;
    }
    if (path === "/login" && method === "GET") {
      send(response, 200, HTML, loginPage());
      return;
    }
    if (path === "/login" && method === "POST") {
      await login(request, response);
      return;
    }

    const token = sessionToken(request);
    if (token === undefined || !sessions.isValid(token)) {
      if (path.startsWith("/api/")) sendJson(response, 401, { error: "unauthorized" });
      else redirect(response, "/login");
      return;
    }

    if (path === "/logout" && method === "POST") {
      sessions.revoke(token);
      response.setHeader(
        "set-cookie",
        `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      );
      redirect(response, "/login");
      return;
    }
    if (path === "/api/session" && method === "GET") {
      sendJson(response, 200, { authenticated: true });
      return;
    }
    if (path === "/" && method === "GET") {
      sendHtml(
        response,
        200,
        layout("Overview", "<h1>Overview</h1>\n<p>No factory projects yet.</p>"),
      );
      return;
    }
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.path.exec(path);
      if (match === null) continue;
      await route.handle({ request, response, url, params: match.slice(1) });
      return;
    }
    if (path.startsWith("/api/")) sendJson(response, 404, { error: "not found" });
    else sendHtml(response, 404, layout("Not found", "<p>Not found.</p>"));
  }

  async function login(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const client = request.socket.remoteAddress ?? "unknown";
    // Reserve a check before any await, so concurrent requests cannot all pass the limits.
    if (isLockedOut(client)) {
      send(response, 429, HTML, loginPage("Too many wrong passwords. Try again later."));
      return;
    }
    if (loginsInFlight >= MAX_CONCURRENT_LOGINS) {
      send(response, 429, HTML, loginPage("The server is busy. Try again."));
      return;
    }
    loginsInFlight += 1;
    reserveAttempt(client);
    let valid = false;
    try {
      const body = await readBody(request, MAX_LOGIN_FORM_BYTES);
      if (body === undefined) {
        send(response, 413, "text/plain; charset=utf-8", "Request too large\n");
        return;
      }
      const password = new URLSearchParams(body).get("password") ?? "";
      const stored = readPasswordHash(db);
      valid = stored !== undefined && (await verifyPassword(password, stored));
    } finally {
      loginsInFlight -= 1;
      // The reserved attempt stays counted as a failure unless the password was right.
      if (valid) failures.delete(client);
    }
    if (!valid) {
      send(response, 401, HTML, loginPage("Wrong password."));
      return;
    }
    const token = sessions.create();
    response.setHeader(
      "set-cookie",
      `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${String(SESSION_TTL_MS / 1000)}`,
    );
    redirect(response, "/");
  }

  function isLockedOut(client: string): boolean {
    const entry = failures.get(client);
    if (entry === undefined) return false;
    if (now() - entry.since >= LOGIN_FAILURE_WINDOW_MS) {
      failures.delete(client);
      return false;
    }
    return entry.count >= LOGIN_FAILURE_LIMIT;
  }

  /** Counts an attempt against the client's limit before its password is checked. */
  function reserveAttempt(client: string): void {
    for (const [key, entry] of failures) {
      if (now() - entry.since >= LOGIN_FAILURE_WINDOW_MS) failures.delete(key);
    }
    const entry = failures.get(client) ?? { count: 0, since: now() };
    entry.count += 1;
    failures.set(client, entry);
  }
}

/**
 * Browsers send Origin on every POST. A page on another port of the same host
 * counts as same-site, so SameSite=Strict alone would let it send the session
 * cookie; requiring Origin to match Host closes that. Clients that send no
 * Origin, such as curl, are not browsers and cannot carry a victim's cookie.
 */
function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  return origin === `http://${request.headers.host ?? ""}`;
}

function sessionToken(request: IncomingMessage): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=");
  }
  return undefined;
}

function loginPage(error?: string): string {
  return page(
    "Sign in",
    `<form class="login" method="post" action="/login">
  <h1>Hephaestus</h1>
  ${error === undefined ? "" : `<p class="error">${escapeHtml(error)}</p>`}
  <label for="password">Dashboard password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Sign in</button>
</form>`,
  );
}
