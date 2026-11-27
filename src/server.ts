import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Database } from "better-sqlite3";
import { SESSION_TTL_MS, Sessions, readPasswordHash, verifyPassword } from "./auth.js";
import { STYLESHEET_PATH, callout, empty, field, layout, page, pageHead } from "./web/html.js";
import {
  HTML,
  cookie,
  readBody,
  redirect,
  send,
  sendHtml,
  sendJson,
  type Route,
  type RouteContext,
  type ShellSource,
} from "./web/http.js";
import { STYLESHEET } from "./web/style.js";
import { LOGO_PATH, brandFile } from "./web/brand.js";

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
  /** Reads what the sidebar shows. Without it pages get the page links and Sign out only. */
  shell?: ShellSource;
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
  shell,
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
    // The stylesheet holds nothing private, and the login page needs it before a session exists.
    if (path === STYLESHEET_PATH && (method === "GET" || method === "HEAD")) {
      send(response, 200, "text/css; charset=utf-8", STYLESHEET);
      return;
    }
    const brand = method === "GET" || method === "HEAD" ? brandFile(path) : undefined;
    if (brand !== undefined) {
      response.writeHead(200, {
        "content-type": brand.contentType,
        "cache-control": "public, max-age=86400",
        "x-content-type-options": "nosniff",
      });
      response.end(method === "HEAD" ? undefined : brand.body);
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

    const token = cookie(request, SESSION_COOKIE);
    let valid: boolean;
    try {
      valid = token !== undefined && sessions.isValid(token);
    } catch (error) {
      // The store holds the sessions too. Access stays closed, and the page says why.
      console.error("Reading the session store failed", error);
      if (path.startsWith("/api/")) sendJson(response, 503, { error: "store unavailable" });
      else send(response, 503, HTML, storeDownPage());
      return;
    }
    if (token === undefined || !valid) {
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
    let shown: RouteContext["shell"];
    let asked = false;
    // A route that only redirects never asks, so the store is not read for it.
    const shellOnce = (): RouteContext["shell"] => {
      if (!asked) {
        shown = shell?.(request, url);
        asked = true;
      }
      return shown;
    };
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.path.exec(path);
      if (match === null) continue;
      await route.handle({
        request,
        response,
        url,
        params: match.slice(1),
        get shell() {
          return shellOnce();
        },
      });
      return;
    }
    if (path.startsWith("/api/")) sendJson(response, 404, { error: "not found" });
    else sendHtml(response, 404, layout("Not found", notFound(), { shell: shellOnce() }));
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
    const reserved = reserveAttempt(client);
    let valid = false;
    try {
      const body = await readBody(request, MAX_LOGIN_FORM_BYTES);
      if (body === undefined) {
        send(response, 413, "text/plain; charset=utf-8", "Request too large\n");
        return;
      }
      const password = new URLSearchParams(body).get("password") ?? "";
      let stored;
      try {
        stored = readPasswordHash(db);
      } catch (error) {
        // An outage is not a wrong password, so the reserved attempt is given back.
        console.error("Reading the password from the store failed", error);
        releaseAttempt(client, reserved);
        send(response, 503, HTML, storeDownPage());
        return;
      }
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

  /** Gives back a reserved attempt, unless its window has since been replaced by a new one. */
  function releaseAttempt(client: string, reserved: { count: number; since: number }): void {
    const entry = failures.get(client);
    if (entry !== reserved) return;
    entry.count -= 1;
    if (entry.count <= 0) failures.delete(client);
  }

  /** Counts an attempt against the client's limit before its password is checked. */
  function reserveAttempt(client: string): { count: number; since: number } {
    for (const [key, entry] of failures) {
      if (now() - entry.since >= LOGIN_FAILURE_WINDOW_MS) failures.delete(key);
    }
    const entry = failures.get(client) ?? { count: 0, since: now() };
    entry.count += 1;
    failures.set(client, entry);
    return entry;
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

const LOGIN_TOP = `<div class="login-head"><img src="${LOGO_PATH}" alt="" width="36" height="36"><h1>Hephaestus</h1></div>`;

/** Shown when the store cannot be read: no session can be checked, so no control is offered. */
function storeDownPage(): string {
  return page(
    "Unavailable",
    `<main class="login" id="main">${LOGIN_TOP}${callout("err", "Hephaestus cannot read its store", "Nothing can be shown or changed until it can. The service log has the error. Reload to try again.")}</main>`,
  );
}

function loginPage(error?: string): string {
  const password = field(
    "password",
    "Dashboard password",
    `<input id="password" name="password" type="password" autocomplete="current-password" required autofocus${error === undefined ? "" : ' aria-describedby="password-err"'}>`,
    { error },
  );
  return page(
    "Sign in",
    `<main class="login" id="main">${LOGIN_TOP}<form class="form" method="post" action="/login">${password}<button type="submit" class="primary">Sign in</button></form></main>`,
  );
}

function notFound(): string {
  return `${pageHead({ title: "Not found" })}${empty('This page does not exist. <a href="/">Back to home</a>')}`;
}
