import type { IncomingMessage, ServerResponse } from "node:http";

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
      "default-src 'none'; style-src 'self' 'unsafe-inline'; form-action 'self'",
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

export interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  /** Capture groups from the route's path pattern. */
  params: string[];
  url: URL;
}

/** A dashboard route. Every route sits behind the session check. */
export interface Route {
  method: "GET" | "POST";
  path: RegExp;
  handle: (context: RouteContext) => void | Promise<void>;
}
