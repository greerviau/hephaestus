import type { IncomingMessage, ServerResponse } from "node:http";
import type { Shell } from "./html.js";

export const HTML = "text/html; charset=utf-8";

export function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy":
      "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; form-action 'self'",
  });
  response.end(body);
}

export function sendHtml(response: ServerResponse, status: number, body: string): void {
  send(response, status, HTML, body);
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  send(response, status, "application/json", JSON.stringify(body));
}

export function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location, "cache-control": "no-store" });
  response.end();
}

/** Reads a request body up to `limit` bytes, or returns undefined when it is larger. */
export async function readBody(
  request: IncomingMessage,
  limit: number,
): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The value of the request cookie `name`, still encoded, or undefined when it was not sent. */
export function cookie(
  request: Pick<IncomingMessage, "headers">,
  name: string,
): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

export interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  /** Capture groups from the route's path pattern. */
  params: string[];
  url: URL;
  /**
   * What the sidebar shows; pass it to `layout`. It is read from the store
   * when first asked for. Undefined when the server was given no source.
   */
  readonly shell: Shell | undefined;
}

/** Reads what the sidebar shows for one request. */
export type ShellSource = (request: IncomingMessage, url: URL) => Shell;

/** A dashboard route. Every route sits behind the session check. */
export interface Route {
  method: "GET" | "POST";
  path: RegExp;
  handle: (context: RouteContext) => void | Promise<void>;
}
