import type { Task } from "../factory/tasks.js";
import type { Evidence } from "../factory/pr-evidence.js";
import { type FactoryPages, read } from "./factory.js";
import { escapeHtml, externalLink, statusText } from "./html.js";
import { send, sendImage, type Route } from "./http.js";
import { LAZY_SCRIPT_TAG } from "./lazy.js";

/** Shown in place of a screenshot the host could not fetch, so the collage keeps its shape. */
const UNAVAILABLE = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120"><rect width="160" height="120" fill="#8884"/><text x="80" y="64" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#888">Image unavailable</text></svg>`;

/** A screenshot's address only changes when the image does, so the browser keeps it a day. */
const IMAGE_CACHE = "private, max-age=86400";

function evidencePath(id: number): string {
  return `/work/${String(id)}/evidence`;
}

function plural(count: number, one: string): string {
  return `${String(count)} ${one}${count === 1 ? "" : "s"}`;
}

const REFRESH = '<button type="button" class="link" data-lazy-refresh>Refresh</button>';

/**
 * The Evidence row in a task's Proof, filled in after the page loads: the
 * PR is read from GitHub, which can be slow, and the page reloads often.
 */
export function evidenceRow(factory: FactoryPages, item: Task): string {
  if (factory.evidence === undefined || item.prNumber === null) return "";
  return `<li class="row evidence" data-lazy-url="${evidencePath(item.id)}" aria-busy="true"><div class="main"><span class="title">Evidence</span><span class="subline">Reading the screenshots on PR #${String(item.prNumber)}...</span></div></li>`;
}

/** The script that fills the Evidence row, for a page that has one. */
export function evidenceScript(factory: FactoryPages, item: Task): string {
  return factory.evidence === undefined || item.prNumber === null ? "" : LAZY_SCRIPT_TAG;
}

/** What the Evidence row shows once the PR is read. */
function filled(id: number, prNumber: number, evidence: Evidence): string {
  const { images, links } = evidence;
  if (images.length === 0 && links.length === 0) {
    return `<div class="main"><span class="title">Evidence</span><span class="subline">No screenshots or evidence links on PR #${String(prNumber)}.</span></div><div class="aside">${statusText("off", "No evidence")}${REFRESH}</div>`;
  }
  const counts = [
    images.length === 0 ? "" : plural(images.length, "screenshot"),
    links.length === 0 ? "" : plural(links.length, "link"),
  ]
    .filter((part) => part !== "")
    .join(", ");
  const shots =
    images.length === 0
      ? ""
      : `<div class="shots">${images
          .map((image) => {
            const src = `${evidencePath(id)}/${image.key}`;
            const alt = image.alt === "" ? "Screenshot" : image.alt;
            return `<a href="${src}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(alt)}"><img src="${src}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async"></a>`;
          })
          .join("")}</div>`;
  const list =
    links.length === 0
      ? ""
      : `<ul class="ev-links">${links.map((link) => `<li>${externalLink(link.href, link.label)}</li>`).join("")}</ul>`;
  return `<div class="main"><span class="title">Evidence</span><span class="subline">${counts} from PR #${String(prNumber)}.</span>${shots}${list}</div><div class="aside">${REFRESH}</div>`;
}

/** The Evidence row's fragment and the screenshots in it. */
export function evidenceRoutes(factory: FactoryPages): Route[] {
  const taskWithPr = (id: number): (Task & { prNumber: number }) | undefined => {
    const found = read("the task", () => factory.tasks.find(id));
    const item = found.ok ? found.value : undefined;
    return item === undefined || item.prNumber === null
      ? undefined
      : { ...item, prNumber: item.prNumber };
  };
  return [
    {
      method: "GET",
      path: /^\/work\/(\d+)\/evidence$/,
      handle: async ({ response, url, params }) => {
        const id = Number(params[0]);
        const item = taskWithPr(id);
        if (factory.evidence === undefined || item === undefined) {
          send(response, 404, "text/html; charset=utf-8", "");
          return;
        }
        let html: string;
        try {
          const evidence = await factory.evidence.list(
            item.repo,
            item.prNumber,
            url.searchParams.get("refresh") === "1",
          );
          html = filled(id, item.prNumber, evidence);
        } catch (error) {
          console.error(
            `Reading the evidence on ${item.repo}#${String(item.prNumber)} failed`,
            error,
          );
          html = `<div class="main"><span class="title">Evidence</span><span class="subline">The screenshots on PR #${String(item.prNumber)} could not be read from GitHub.</span></div><div class="aside">${statusText("bad", "Could not read the PR")}${REFRESH}</div>`;
        }
        send(response, 200, "text/html; charset=utf-8", html);
      },
    },
    {
      method: "GET",
      path: /^\/work\/(\d+)\/evidence\/([0-9a-f]{16})$/,
      handle: async ({ response, params }) => {
        const item = taskWithPr(Number(params[0]));
        let image;
        try {
          image =
            factory.evidence === undefined || item === undefined
              ? undefined
              : await factory.evidence.image(item.repo, item.prNumber, params[1] ?? "");
        } catch (error) {
          console.error("Fetching an evidence image failed", error);
        }
        if (image === undefined) {
          // A placeholder, not an error status, so the collage shows a tile that says what happened.
          sendImage(response, "image/svg+xml", UNAVAILABLE, "no-store");
          return;
        }
        sendImage(response, image.contentType, image.data, IMAGE_CACHE);
      },
    },
  ];
}
