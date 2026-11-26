import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** `assets/brand/` in the repo; the same relative path works from `src/` and `dist/`. */
const BRAND = fileURLToPath(new URL("../../assets/brand/", import.meta.url));

/** The brand files the dashboard serves, by name, with their content types. */
const FILES: Record<string, string> = {
  "favicon.ico": "image/x-icon",
  "favicon-16.png": "image/png",
  "favicon-32.png": "image/png",
  "apple-touch-icon.png": "image/png",
  "logo-192.png": "image/png",
  "logo-512.png": "image/png",
};

const cache = new Map<string, Buffer>();

/**
 * The brand file a request path names, read once and kept in memory. Only
 * the listed names are served, so no path can reach another file.
 */
export function brandFile(path: string): { contentType: string; body: Buffer } | undefined {
  const name =
    path === "/favicon.ico" ? "favicon.ico" : /^\/assets\/brand\/([^/]+)$/.exec(path)?.[1];
  if (name === undefined || !Object.hasOwn(FILES, name)) return undefined;
  let body = cache.get(name);
  if (body === undefined) {
    body = readFileSync(`${BRAND}${name}`);
    cache.set(name, body);
  }
  return { contentType: FILES[name] ?? "application/octet-stream", body };
}

/** The icon links every page's head carries. */
export const ICON_LINKS = `<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/brand/favicon-32.png">
<link rel="apple-touch-icon" href="/assets/brand/apple-touch-icon.png">`;

export const LOGO_PATH = "/assets/brand/logo-192.png";
