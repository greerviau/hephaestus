import { ICON_LINKS, LOGO_PATH } from "./brand.js";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for use in HTML content and attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

export const STYLESHEET_PATH = "/assets/app.css";

/**
 * A complete HTML document. `title` is escaped; `body` must already be safe
 * HTML. `refreshSeconds` reloads the page, which is how a section that is
 * still loading fills in without JavaScript.
 */
export function page(title: string, body: string, refreshSeconds?: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshSeconds === undefined ? "" : `<meta http-equiv="refresh" content="${String(refreshSeconds)}">\n`}<title>${escapeHtml(title)} - Hephaestus</title>
<link rel="stylesheet" href="${STYLESHEET_PATH}">
${ICON_LINKS}
</head>
<body>
${body}
</body>
</html>
`;
}

export const NAV = [
  ["/", "Overview"],
  ["/work", "Work items"],
  ["/pipeline", "Pipeline"],
  ["/activity", "Activity"],
  ["/analytics", "Analytics"],
  ["/improvement", "Improvement"],
  ["/environments", "Workers"],
  ["/settings", "Settings"],
] as const;

export type Section = (typeof NAV)[number][0];

export interface LayoutOptions {
  /** The tab to mark as the current page. */
  section?: Section;
  refreshSeconds?: number;
}

/** A signed-in page with the header and tabs. `body` must already be safe HTML. */
export function layout(title: string, body: string, options: LayoutOptions = {}): string {
  const links = NAV.map(
    ([href, label]) =>
      `<a href="${href}"${href === options.section ? ' aria-current="page"' : ""}>${label}</a>`,
  ).join("\n      ");
  return page(
    title,
    `<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="wrap">
    <div class="top-row">
      <a class="brand" href="/"><img src="${LOGO_PATH}" alt="" width="24" height="24">Hephaestus</a>
      <div class="top-actions">
        <form method="post" action="/logout"><button type="submit" class="linkbtn">Sign out</button></form>
      </div>
    </div>
    <nav class="tabs" aria-label="Pages">
      ${links}
    </nav>
  </div>
</header>
<main class="wrap" id="main" tabindex="-1">
${body}
</main>`,
    options.refreshSeconds,
  );
}

const ICONS = {
  ok: '<circle cx="8" cy="8" r="6.5"/><path d="M5 8.2l2 2 4-4.2"/>',
  clock: '<circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 1.5"/>',
  arrow: '<path d="M3 8h9M9 5l3 3-3 3"/>',
  warn: '<path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.5v3M8 11.5v.2"/>',
  x: '<circle cx="8" cy="8" r="6.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/>',
  q: '<circle cx="8" cy="8" r="6.5"/><path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4M8 11.6v.2"/>',
  pause: '<circle cx="8" cy="8" r="6.5"/><path d="M6.5 5.5v5M9.5 5.5v5"/>',
  slash: '<circle cx="8" cy="8" r="6.5"/><path d="M4 12l8-8"/>',
  sync: '<path d="M13 5.5A5.5 5.5 0 0 0 3 6M3 10.5A5.5 5.5 0 0 0 13 10M13 2.5v3h-3M3 13.5v-3h3"/>',
  ext: '<path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, className?: string): string {
  return `<svg class="ic${className === undefined ? "" : ` ${className}`}" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}

export type Tone = "good" | "warn" | "crit" | "neutral" | "muted";

/** An icon and a line of text in one tone. `html` must already be safe. */
export function status(tone: Tone, name: IconName, html: string): string {
  return `<span class="status s-${tone}">${icon(name)}<span>${html}</span></span>`;
}

export type PillKind = "run" | "you" | "wait" | "done" | "off" | "bad";

const PILL_ICONS: Partial<Record<PillKind, IconName>> = {
  you: "q",
  wait: "clock",
  done: "ok",
  off: "slash",
  bad: "x",
};

/** A status pill: the color says the category, the icon repeats it, the label says it in words. */
export function pill(kind: PillKind, label: string): string {
  const mark = PILL_ICONS[kind];
  return `<span class="pill p-${kind}">${mark === undefined ? '<span class="dot"></span>' : icon(mark)}${escapeHtml(label)}</span>`;
}

export interface CardOptions {
  title: string;
  /** Safe HTML shown at the right of the heading. */
  meta?: string;
  /** Safe HTML. */
  body: string;
  span?: 4 | 5 | 6 | 7 | 8 | 12;
  className?: string | undefined;
  busy?: boolean;
}

let headingIds = 0;

export function card(options: CardOptions): string {
  headingIds = (headingIds + 1) % 1_000_000;
  const id = `h-${String(headingIds)}`;
  return `<section class="card span-${String(options.span ?? 12)}${options.className === undefined ? "" : ` ${options.className}`}" aria-labelledby="${id}"${options.busy === true ? ' aria-busy="true"' : ""}>
<div class="card-head"><h2 id="${id}">${escapeHtml(options.title)}</h2>${options.meta ?? ""}</div>
${options.body}
</section>`;
}

/** The mockup's banner. `title` and `text` are escaped. */
export function banner(kind: "err" | "info", title: string, text: string): string {
  return `<div class="banner ${kind}"${kind === "err" ? ' role="alert"' : ""}><strong class="status ${kind === "err" ? "s-crit" : "s-neutral"}">${icon(kind === "err" ? "x" : "q")}<span>${escapeHtml(title)}</span></strong><p>${escapeHtml(text)}</p></div>`;
}

/** An empty state. `html` must already be safe. */
export function empty(html: string): string {
  return `<p class="empty">${html}</p>`;
}

export function loading(text = "Loading..."): string {
  return `<p class="loading">${escapeHtml(text)}</p><div class="skel" aria-hidden="true"><span></span><span></span><span></span></div>`;
}

export interface PageHead {
  title: string;
  /** Safe HTML under the title. */
  lede?: string;
  /** Safe HTML at the right. */
  actions?: string;
  /** Safe HTML breadcrumb links. */
  crumbs?: string;
}

export function pageHead(head: PageHead): string {
  return `${head.crumbs === undefined ? "" : `<nav class="crumbs" aria-label="Breadcrumb">${head.crumbs}</nav>`}<div class="page-head"><div><h1 id="page-title">${escapeHtml(head.title)}</h1>${head.lede === undefined ? "" : `<p class="lede">${head.lede}</p>`}</div>${head.actions === undefined ? "" : `<div class="page-actions">${head.actions}</div>`}</div>`;
}

export interface Column {
  /** The header text, escaped. */
  label: string;
  right?: boolean;
  className?: string | undefined;
}

/** A table whose rows stack on narrow screens. Cells must already be safe HTML. */
export function table(columns: Column[], rows: string[][], caption?: string): string {
  const head = columns
    .map(
      (column) =>
        `<th scope="col"${column.right === true ? ' class="r"' : ""}>${escapeHtml(column.label)}</th>`,
    )
    .join("");
  const body = rows
    .map(
      (cells) =>
        `<tr>${columns
          .map((column, index) => {
            const classes = [column.right === true ? "r num" : "", column.className ?? ""]
              .join(" ")
              .trim();
            const cell = cells[index] ?? "";
            const wrapped =
              column.className?.includes("title-cell") === true
                ? cell
                : `<div class="cv">${cell}</div>`;
            return `<td${classes === "" ? "" : ` class="${classes}"`} data-label="${escapeHtml(column.label)}">${wrapped}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("\n");
  return `<div class="table-scroll"><table class="stack">${caption === undefined ? "" : `<caption class="sr">${escapeHtml(caption)}</caption>`}<thead><tr>${head}</tr></thead><tbody>
${body}
</tbody></table></div>`;
}

export interface ButtonOptions {
  /** Hidden form fields. */
  fields?: Record<string, string>;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  /** Smaller button for lists. */
  small?: boolean;
}

/** A form with one button that POSTs to `action`. */
export function postButton(action: string, label: string, options: ButtonOptions = {}): string {
  const fields = Object.entries(options.fields ?? {})
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("");
  return `<form class="inline" method="post" action="${escapeHtml(action)}">${fields}<button type="submit" class="btn-${options.variant ?? "secondary"}${options.small === false ? "" : " btn-s"}"${options.disabled === true ? " disabled" : ""}>${escapeHtml(label)}</button></form>`;
}

/**
 * An action that needs a line of text first, such as a reason. Without
 * JavaScript, a details element stands in for the mockup's dialog.
 */
export function textAction(
  action: string,
  label: string,
  input: { name: string; label: string; placeholder?: string },
  options: ButtonOptions & { crit?: boolean } = {},
): string {
  if (options.disabled === true) {
    return `<button type="button" class="btn-secondary btn-s" disabled>${escapeHtml(label)}</button>`;
  }
  const fields = Object.entries(options.fields ?? {})
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("");
  return `<details class="act${options.crit === true ? " crit" : ""}"><summary>${escapeHtml(label)}</summary><form method="post" action="${escapeHtml(action)}">${fields}<label>${escapeHtml(input.label)}<input type="text" name="${escapeHtml(input.name)}" required maxlength="2000"${input.placeholder === undefined ? "" : ` placeholder="${escapeHtml(input.placeholder)}"`}></label><button type="submit" class="btn-${options.variant ?? (options.crit === true ? "danger" : "primary")} btn-s">${escapeHtml(label)}</button></form></details>`;
}

/** A link to a page outside the dashboard, such as GitHub. */
export function externalLink(href: string, label: string): string {
  return `<a class="ext" href="${escapeHtml(href)}" rel="noreferrer">${escapeHtml(label)}${icon("ext")}</a>`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A UTC timestamp: the time alone when it is from today, else the date too. */
export function when(iso: string, now: number): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return escapeHtml(iso);
  const hm = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
  const today = new Date(now).toISOString().slice(0, 10) === iso.slice(0, 10);
  const label = today ? hm : `${MONTHS[at.getUTCMonth()] ?? ""} ${String(at.getUTCDate())} ${hm}`;
  return `<time datetime="${escapeHtml(at.toISOString())}" title="${escapeHtml(at.toISOString())}">${label}</time>`;
}

/** "Nov 20" for a UTC day `YYYY-MM-DD`. */
export function dayLabel(day: string): string {
  const [, month, date] = day.split("-");
  return `${MONTHS[Number(month) - 1] ?? ""} ${String(Number(date))}`;
}

/** A path inside the dashboard to return to after an action, or `fallback`. */
export function backTo(value: string | null, fallback: string): string {
  return value !== null && /^\/(?![/\\])[\x21-\x7e]*$/.test(value) ? value : fallback;
}

/** A labelled select for a GET filter form. */
export function selectField(
  name: string,
  label: string,
  options: readonly (readonly [string, string])[],
  value: string,
): string {
  return `<div class="field"><label for="${escapeHtml(name)}">${escapeHtml(label)}</label><select id="${escapeHtml(name)}" name="${escapeHtml(name)}">${options
    .map(
      ([option, text]) =>
        `<option value="${escapeHtml(option)}"${option === value ? " selected" : ""}>${escapeHtml(text)}</option>`,
    )
    .join("")}</select></div>`;
}
