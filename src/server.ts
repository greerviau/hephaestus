import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Database } from "better-sqlite3";
import { SESSION_TTL_MS, Sessions, readPasswordHash, verifyPassword } from "./auth.js";

export const SESSION_COOKIE = "hephaestus_session";
const MAX_FORM_BYTES = 4096;

export interface DashboardOptions {
  db: Database;
  now?: () => number;
}

/**
 * The dashboard. Every route except the login page requires a session: pages
 * redirect to /login and API routes answer 401.
 */
export function createDashboardServer({ db, now = Date.now }: DashboardOptions): Server {
  const sessions = new Sessions(db, now);

  return createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      console.error("dashboard request failed", error);
      if (!response.headersSent)
        send(response, 500, "text/plain; charset=utf-8", "Internal error\n");
      else response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const method = request.method ?? "GET";

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
    } else if (path === "/api/session" && method === "GET") {
      sendJson(response, 200, { authenticated: true });
    } else if (path.startsWith("/api/")) {
      sendJson(response, 404, { error: "not found" });
    } else if (path === "/" && method === "GET") {
      send(response, 200, HTML, shellPage());
    } else {
      send(response, 404, HTML, page("Not found", "<p>Not found.</p>"));
    }
  }

  async function login(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    if (body === undefined) {
      send(response, 413, "text/plain; charset=utf-8", "Request too large\n");
      return;
    }
    const password = new URLSearchParams(body).get("password") ?? "";
    const stored = readPasswordHash(db);
    if (stored === undefined || !verifyPassword(password, stored)) {
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
}

function sessionToken(request: IncomingMessage): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=");
  }
  return undefined;
}

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_FORM_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const HTML = "text/html; charset=utf-8";

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  send(response, status, "application/json", JSON.stringify(body));
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location, "cache-control": "no-store" });
  response.end();
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - Hephaestus</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; }
  header { display: flex; align-items: center; gap: 1rem; padding: 0.75rem 1rem; border-bottom: 1px solid #8884; }
  header nav { flex: 1; display: flex; gap: 1rem; }
  main { padding: 1rem; max-width: 60rem; }
  form.login { display: grid; gap: 0.5rem; max-width: 20rem; margin: 4rem auto; }
  .error { color: #c33; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function loginPage(error?: string): string {
  return page(
    "Sign in",
    `<form class="login" method="post" action="/login">
  <h1>Hephaestus</h1>
  ${error === undefined ? "" : `<p class="error">${error}</p>`}
  <label for="password">Dashboard password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Sign in</button>
</form>`,
  );
}

function shellPage(): string {
  return page(
    "Overview",
    `<header>
  <strong>Hephaestus</strong>
  <nav><a href="/">Overview</a></nav>
  <form method="post" action="/logout"><button type="submit">Sign out</button></form>
</header>
<main>
  <h1>Overview</h1>
  <p>No factory projects yet.</p>
</main>`,
  );
}
