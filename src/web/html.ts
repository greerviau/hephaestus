import { ICON_LINKS, LOGO_PATH } from "./brand.js";
import type { DeployStatus } from "./deploys.js";
import { LIVE_SCRIPT_PATH } from "./live.js";
import { PROJECT_FILTER_SCRIPT_TAG } from "./project-filter.js";

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

/**
 * The entry of `table` that `key` names. A key that comes from a request can
 * name a property every object inherits, such as `constructor`, which is not
 * an entry.
 */
export function lookup<T>(table: Readonly<Record<string, T>>, key: string | null): T | undefined {
  return key !== null && Object.hasOwn(table, key) ? table[key] : undefined;
}

export const STYLESHEET_PATH = "/assets/app.css";

function refreshTags(seconds: number, url: string | undefined): string {
  const meta = `<meta http-equiv="refresh" content="${String(seconds)}${url === undefined ? "" : `;url=${escapeHtml(url)}`}">`;
  const live = url === undefined ? "" : ` data-live-url="${escapeHtml(url)}"`;
  return `<noscript>${meta}</noscript>\n<script src="${LIVE_SCRIPT_PATH}" data-live-seconds="${String(seconds)}"${live} defer></script>\n`;
}

/**
 * A complete HTML document. `title` is escaped; `body` must already be safe
 * HTML. `refreshSeconds` keeps the page current: a script fetches it again
 * and swaps in the regions that changed, and a meta refresh reloads it for a
 * browser that runs no scripts. `refreshUrl` is the local path both load;
 * without it they load the current address again.
 */
export function page(
  title: string,
  body: string,
  refreshSeconds?: number,
  refreshUrl?: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshSeconds === undefined ? "" : refreshTags(refreshSeconds, refreshUrl)}<title>${escapeHtml(title)} - Hephaestus</title>
<link rel="stylesheet" href="${STYLESHEET_PATH}">
${ICON_LINKS}
</head>
<body>
${body}
</body>
</html>
`;
}

/** The pages in the sidebar, by group. */
const NAV = [
  [
    "Factory",
    [
      ["/", "Home"],
      ["/work", "Work"],
      ["/activity", "Activity"],
      ["/analytics", "Analytics"],
    ],
  ],
  [
    "Setup",
    [
      ["/projects", "Projects"],
      ["/workers", "Workers"],
      ["/chat", "Chat"],
      ["/proposals", "Proposals"],
      ["/config", "Config"],
    ],
  ],
] as const;

/** A sidebar page, named by its path. */
export type Section = (typeof NAV)[number][1][number][0];

/** Where the project picker posts; `shell.ts` holds the route. */
export const PROJECT_FILTER_PATH = "/project-filter";

/**
 * What the sidebar shows besides the page links. A route gets it as
 * `context.shell` and hands it to `layout`.
 */
export interface Shell {
  /** Whether the factory is paused. Undefined when the store could not say, which turns the control off. */
  paused: boolean | undefined;
  /** Factory threads running now, for the pause dialog. Undefined when unknown. */
  runningThreads: number | undefined;
  /** How many things need the owner, across every project. */
  needsYou: number;
  /** Proposals waiting for the owner. */
  proposals: number;
  /** The factory's projects, as `owner/name`. */
  projects: readonly string[];
  /** The project the picker is set to. Undefined means all projects. */
  project: string | undefined;
  /** The commit the service runs, how far origin/main is ahead of it, and the command that updates it. */
  version?: {
    commit: string;
    behind?: number;
    command: string;
    updatable?: boolean;
    /** Whether an update runs now. Read only while origin/main is ahead. */
    updating?: boolean;
  };
  /** Config deploys under way or just ended; absent when nothing deploys here. */
  deploys?: DeployStatus;
  /**
   * The page's own address without a result notice: where the picker and the
   * pause control return to, and what a reloading page reloads. Undefined on
   * a page a form posted to.
   */
  back: string | undefined;
}

/** One breadcrumb: its text, and its link unless it is the current page. */
export type Crumb = readonly [label: string, href?: string];

export interface LayoutOptions {
  /** The sidebar link to mark as the current page. */
  section?: Section;
  /** `context.shell`. Without it the sidebar has only the page links and Sign out. */
  shell?: Shell | undefined;
  /** Breadcrumbs above the page, ending with the current page as text. */
  crumbs?: readonly Crumb[];
  /**
   * Reloads the page this often, at `shell.back`, so the query string stays
   * and a result notice is shown once.
   */
  refreshSeconds?: number;
  /** False on a page that has its own update control, so it shows no update notice. */
  updateNotice?: boolean;
}

function hiddenFields(fields: Record<string, string> | undefined): string {
  return Object.entries(fields ?? {})
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("");
}

function navBadge(href: string, shell: Shell | undefined): string {
  const [count, what] =
    href === "/"
      ? [shell?.needsYou ?? 0, "need you"]
      : href === "/proposals"
        ? [shell?.proposals ?? 0, "waiting"]
        : [0, ""];
  return count > 0
    ? `<span class="count">${String(count)}<span class="sr-only"> ${what}</span></span>`
    : "";
}

function projectPicker(shell: Shell, back: string): string {
  if (shell.projects.length === 0) return "";
  const short = (repo: string): string => repo.slice(repo.indexOf("/") + 1);
  const options = shell.projects
    .map((repo) => {
      // The repo name alone is enough unless another project has the same one.
      const unique = shell.projects.filter((other) => short(other) === short(repo)).length === 1;
      return `<option value="${escapeHtml(repo)}"${repo === shell.project ? " selected" : ""}>${escapeHtml(unique ? short(repo) : repo)}</option>`;
    })
    .join("");
  return `<form class="scope" method="post" action="${PROJECT_FILTER_PATH}">${hiddenFields({ back })}<label class="nav-label" for="shell-project">Project</label><select id="shell-project" name="project" data-submit-on-change><option value="">All projects</option>${options}</select><noscript><button type="submit">Apply</button></noscript></form>${PROJECT_FILTER_SCRIPT_TAG}`;
}

const PAUSE_DIALOG = "pause-dialog";

function runningLine(count: number | undefined): string {
  if (count === undefined) return "Running threads finish.";
  if (count === 0) return "No thread is running now.";
  return count === 1
    ? "The 1 running thread finishes."
    : `The ${String(count)} running threads finish.`;
}

/** The commit the service runs, and how to update it when origin/main is ahead. */
function versionLines(version: NonNullable<Shell["version"]>): string {
  const behind = version.behind ?? 0;
  const ahead =
    behind === 0
      ? ""
      : `<p class="hint side-update">${behind === 1 ? "1 new commit" : `${String(behind)} new commits`} on origin/main. ${
          version.updatable === true
            ? '<a href="/update">Update</a>'
            : `To update, run <code>${escapeHtml(version.command)}</code> on the Hermes host.`
        }</p>`;
  return `<div class="row-line"><span class="muted">Version <code>${escapeHtml(version.commit.slice(0, 7))}</code></span></div>${ahead}`;
}

/** The notice at the top of every page while origin/main has commits the service lacks. */
function updateNotice(version: NonNullable<Shell["version"]>): string {
  const behind = version.behind ?? 0;
  if (behind === 0) return "";
  const commits = `${behind === 1 ? "1 new commit" : `${String(behind)} new commits`} on origin/main.`;
  const box = (title: string, html: string, actions?: string): string =>
    callout("info", title, html, actions).replace(
      'class="box info"',
      'class="box info update-notice"',
    );
  if (version.updatable !== true) {
    return box(
      "Update available",
      `${commits} To update, run <code>${escapeHtml(version.command)}</code> on the Hermes host.`,
    );
  }
  if (version.updating === true) {
    return box("Updating", `${commits} <a href="/update">Follow the update</a>.`);
  }
  return box(
    "Update available",
    `${commits} Updating restarts the service.`,
    `${postButton("/update", "Update now", { variant: "primary" })}<a href="/update">Details</a>`,
  );
}

/** How many seconds a page waits before it fetches itself again while a deploy runs. */
const DEPLOY_REFRESH_SECONDS = 3;

/** The sidebar's deploy status: what runs now, and how the last deploy ended. Empty when there is nothing to say. */
function deployLines(status: DeployStatus): string {
  const lines: string[] = [];
  const link = (version: number): string => `/config/versions/${String(version)}`;
  const { running, last } = status;
  if (running !== undefined) {
    const queued = running.queued === 0 ? "" : ` (${String(running.queued)} more waiting)`;
    lines.push(
      `<div class="row-line">${statusText("run", `Deploying version ${String(running.version)}${queued}`)}</div>`,
    );
  }
  if (last?.outcome === "succeeded") {
    lines.push(
      `<div class="row-line">${statusText("done", `Deployed version ${String(last.version)}`)}</div>`,
    );
  } else if (last !== undefined) {
    const label =
      last.outcome === "failed"
        ? `Deploying version ${String(last.version)} failed`
        : `Version ${String(last.version)} deployed, but not applied to the factory Hermes root`;
    lines.push(
      `<div class="row-line">${statusText("bad", label)}</div><p class="hint">The service log has the error. <a href="${link(last.version)}">Open the version</a> to deploy it again.</p>`,
    );
  }
  return lines.length === 0
    ? ""
    : `<div class="deploy-status" role="status">${lines.join("")}</div>`;
}

/** The running state with its Pause or Resume control, and the dialog Pause opens. */
function pauseControl(shell: Shell, back: string): { line: string; dialog: string } {
  if (shell.paused === undefined) {
    return {
      line: `${statusText("off", "State unknown")}<button type="button" disabled>Pause</button>`,
      dialog: "",
    };
  }
  if (shell.paused) {
    return {
      line: `${statusText("off", "Paused")}${postButton("/factory/resume", "Resume", { fields: { back } })}`,
      dialog: "",
    };
  }
  return {
    line: `${statusText("run", "Running")}${dialogButton(PAUSE_DIALOG, "Pause")}`,
    dialog: dialog({
      id: PAUSE_DIALOG,
      title: "Pause factory",
      body: `<p>No thread starts or resumes until you resume. ${runningLine(shell.runningThreads)}</p>`,
      action: "/factory/pause",
      fields: { back },
      submit: "Pause factory",
    }),
  };
}

/**
 * A signed-in page: the sidebar, then `body` in the main region. `body` must
 * already be safe HTML and hold the page's one h1.
 */
export function layout(title: string, body: string, options: LayoutOptions = {}): string {
  const { shell, section } = options;
  const back = shell?.back ?? section ?? "/";
  const groups = NAV.map(
    ([group, links]) =>
      `<div class="nav-group"><span class="nav-label">${group}</span>${links
        .map(
          ([href, label]) =>
            `<a href="${href}"${href === section ? ' aria-current="page"' : ""}><span class="lbl">${label}</span>${navBadge(href, shell)}</a>`,
        )
        .join("")}</div>`,
  ).join("\n");
  const pause = shell === undefined ? undefined : pauseControl(shell, back);
  const brand = `<a class="brand" href="/"><img src="${LOGO_PATH}" alt="" width="24" height="24">hephaestus</a>`;
  const crumbs =
    options.crumbs === undefined || options.crumbs.length === 0
      ? ""
      : `<nav class="crumbs" aria-label="Breadcrumb">${options.crumbs
          .map(([label, href]) =>
            href === undefined
              ? `<span>${escapeHtml(label)}</span>`
              : `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a><span aria-hidden="true">/</span>`,
          )
          .join("")}</nav>`;
  // The sidebar is a popover so the Menu button can open it on a small screen without a script; the stylesheet keeps it in place on a wide one.
  return page(
    title,
    `<a class="skip" href="#main">Skip to content</a>
<div class="shell">
<header class="top">${brand}<button type="button" popovertarget="side">${icon("menu")}Menu</button></header>
<aside class="side" id="side" popover>
<div class="side-head">${brand}<button type="button" class="icon-btn side-close" popovertarget="side" popovertargetaction="hide" aria-label="Close menu">${icon("close")}</button></div>
${shell === undefined ? "" : projectPicker(shell, back)}
<nav class="side-nav" aria-label="Pages">
${groups}
</nav>
<div class="side-foot">${pause === undefined ? "" : `<div class="row-line">${pause.line}</div>`}${shell?.version === undefined ? "" : versionLines(shell.version)}${shell?.deploys === undefined ? "" : deployLines(shell.deploys)}<div class="row-line"><form method="post" action="/logout"><button type="submit" class="link">Sign out</button></form></div></div>
</aside>
<main id="main" tabindex="-1"><div class="page">
${options.updateNotice === false || shell?.version === undefined ? "" : updateNotice(shell.version)}${crumbs}${body}
</div></main>
</div>
${pause?.dialog ?? ""}`,
    // A deploy under way keeps every page current, so the sidebar shows how it ends.
    options.refreshSeconds ??
      (shell?.deploys?.running === undefined || shell.back === undefined
        ? undefined
        : DEPLOY_REFRESH_SECONDS),
    shell?.back,
  );
}

const ICONS = {
  ok: '<circle cx="8" cy="8" r="6.5"/><path d="M5 8.2l2 2 4-4.2"/>',
  tick: '<path d="M3.5 8.5l3 3 6-6.5"/>',
  loop: '<path d="M13 8.5a5 5 0 1 1-1.5-4"/><path d="M12 1.8v3h-3"/>',
  clock: '<circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 1.5"/>',
  arrow: '<path d="M3 8h9M9 5l3 3-3 3"/>',
  warn: '<path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.5v3M8 11.5v.2"/>',
  x: '<circle cx="8" cy="8" r="6.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/>',
  q: '<circle cx="8" cy="8" r="6.5"/><path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4M8 11.6v.2"/>',
  pause: '<circle cx="8" cy="8" r="6.5"/><path d="M6.5 5.5v5M9.5 5.5v5"/>',
  slash: '<circle cx="8" cy="8" r="6.5"/><path d="M4 12l8-8"/>',
  sync: '<path d="M13 5.5A5.5 5.5 0 0 0 3 6M3 10.5A5.5 5.5 0 0 0 13 10M13 2.5v3h-3M3 13.5v-3h3"/>',
  ext: '<path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5"/>',
  dots: '<path d="M3.5 8h.1M8 8h.1M12.5 8h.1"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  menu: '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>',
  info: '<circle cx="8" cy="8" r="6.5"/><path d="M8 7.2v4M8 4.8v.2"/>',
} as const;

export type IconName = keyof typeof ICONS;

/** A 16px line icon, hidden from screen readers. `className` adds classes such as a tone. */
export function icon(name: IconName, className?: string): string {
  return `<svg class="ic${className === undefined ? "" : ` ${className}`}" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}

export interface PageHead {
  title: string;
  /** Safe HTML under the title. */
  lede?: string;
  /** Safe HTML at the right, such as buttons. */
  actions?: string;
}

/** The top of a page: its h1, an optional line under it, and optional actions at the right. */
export function pageHead(head: PageHead): string {
  return `<div class="head"><div><h1 id="page-title">${escapeHtml(head.title)}</h1>${head.lede === undefined ? "" : `<p class="sub">${head.lede}</p>`}</div>${head.actions === undefined ? "" : `<div class="acts">${head.actions}</div>`}</div>`;
}

export interface SectionOptions {
  title: string;
  /** Shown muted after the heading. */
  count?: number | undefined;
  /** Safe HTML at the right of the heading, such as a link. */
  right?: string | undefined;
  /** Safe HTML. */
  body: string;
}

/** A page section: an h2 over a hairline, with an optional count and right-side content. */
export function section(options: SectionOptions): string {
  return `<section class="sec"><div class="sec-head"><h2>${escapeHtml(options.title)}${options.count === undefined ? "" : `<span class="n">${String(options.count)}</span>`}</h2>${options.right ?? ""}</div>${options.body}</section>`;
}

export type StatusTone = "run" | "you" | "wait" | "done" | "off" | "bad" | "back";

const STATUS_ICONS: Partial<Record<StatusTone, IconName>> = {
  back: "loop",
  you: "q",
  wait: "clock",
  done: "ok",
  off: "slash",
  bad: "x",
};

/** A status as text in its tone, after a dot (running) or an icon. `label` is escaped. */
export function statusText(tone: StatusTone, label: string): string {
  const mark = STATUS_ICONS[tone];
  return `<span class="st t-${tone}">${mark === undefined ? '<span class="dot"></span>' : icon(mark)}${escapeHtml(label)}</span>`;
}

const CALLOUT_ICONS = { err: "x", warn: "warn", info: "info" } as const;

/** A bordered callout. `title` is escaped; `html` and `actions` must already be safe. An error is announced. */
export function callout(
  kind: "info" | "warn" | "err",
  title: string,
  html?: string,
  actions?: string,
): string {
  return `<div class="box ${kind}"${kind === "err" ? ' role="alert"' : ""}><div class="box-title">${icon(CALLOUT_ICONS[kind])}<span>${escapeHtml(title)}</span></div>${html === undefined || html === "" ? "" : `<p>${html}</p>`}${actions === undefined || actions === "" ? "" : `<div class="acts">${actions}</div>`}</div>`;
}

/** An empty state. `html` must already be safe. */
export function empty(html: string): string {
  return `<p class="empty">${html}</p>`;
}

/** A section that is still loading: its text, and bars where the content will be. */
export function loading(text = "Loading..."): string {
  return `<p class="empty" aria-busy="true">${escapeHtml(text)}</p><div class="skel" aria-hidden="true"><span></span><span></span><span></span></div>`;
}

export interface Row {
  /** Escaped. */
  title: string;
  /** Safe HTML shown as the title in place of `title`, for a title that links outside the dashboard. */
  titleHtml?: string | undefined;
  /** Where the title links, or the whole row with `wholeRow`. */
  href?: string | undefined;
  /** Safe HTML on a muted line under the title. */
  sub?: string | undefined;
  /** A muted word in a left column, such as "merge". Escaped. */
  kind?: string | undefined;
  /** Safe HTML at the right: a status, a time, buttons, a menu. */
  aside?: string | undefined;
  /** Makes the whole row the link. Only for rows whose `aside` holds no control. */
  wholeRow?: boolean;
}

/** A hairline list of rows: a title with a line under it, and content at the right. */
export function rowList(rows: readonly Row[]): string {
  return `<ul class="rows">${rows
    .map((row) => {
      const whole = row.wholeRow === true && row.href !== undefined;
      const title =
        row.titleHtml !== undefined
          ? `<span class="title">${row.titleHtml}</span>`
          : row.href === undefined || whole
            ? `<span class="title">${escapeHtml(row.title)}</span>`
            : `<a class="title" href="${escapeHtml(row.href)}">${escapeHtml(row.title)}</a>`;
      const inner = `${row.kind === undefined ? "" : `<span class="kind">${escapeHtml(row.kind)}</span>`}<div class="main">${title}${row.sub === undefined ? "" : `<span class="subline">${row.sub}</span>`}</div>${row.aside === undefined ? "" : `<div class="aside">${row.aside}</div>`}`;
      const classes = `row${row.kind === undefined ? "" : " kinded"}`;
      return whole
        ? `<li><a class="${classes}" href="${escapeHtml(row.href ?? "")}">${inner}</a></li>`
        : `<li class="${classes}">${inner}</li>`;
    })
    .join("")}</ul>`;
}

export interface GridColumn {
  /** The header text, escaped. */
  label: string;
  right?: boolean;
  /** Classes for the column's cells, such as `c-pr` to drop it on a phone. */
  className?: string;
}

export interface GridRow {
  /** Makes the whole row a link. */
  href?: string | undefined;
  /** Safe HTML, one per column. */
  cells: readonly string[];
}

/** Use in the first cell of a grid row: a title with a muted line under it. `title` is escaped. */
export function rowTitle(title: string, sub?: string): string {
  return `<div class="main"><span class="title">${escapeHtml(title)}</span>${sub === undefined ? "" : `<span class="subline">${sub}</span>`}</div>`;
}

/**
 * Rows laid out in columns under a header row. `template` is the CSS
 * grid-template-columns value; without it the columns are the Work list's.
 */
export function gridRowList(
  columns: readonly GridColumn[],
  rows: readonly GridRow[],
  template?: string,
): string {
  const style =
    template === undefined ? "" : ` style="grid-template-columns:${escapeHtml(template)}"`;
  const cellClass = (column: GridColumn | undefined): string => {
    const classes = [column?.right === true ? "r" : "", column?.className ?? ""].join(" ").trim();
    return classes === "" ? "" : ` class="${classes}"`;
  };
  const head = columns
    .map((column) => `<span${cellClass(column)}>${escapeHtml(column.label)}</span>`)
    .join("");
  const body = rows
    .map((row) => {
      const cells = row.cells
        .map((cell, index) => `<span${cellClass(columns[index])}>${cell}</span>`)
        .join("");
      return row.href === undefined
        ? `<li class="grid-row"${style}>${cells}</li>`
        : `<li><a class="grid-row" href="${escapeHtml(row.href)}"${style}>${cells}</a></li>`;
    })
    .join("");
  return `<div class="grid-head" aria-hidden="true"${style}>${head}</div><ul class="rows">${body}</ul>`;
}

export interface Tab {
  href: string;
  /** Escaped. */
  label: string;
  count?: number | undefined;
  current?: boolean;
}

/** Underlined tabs, each a link. `label` names the group for screen readers. */
export function tabs(items: readonly Tab[], label = "Views"): string {
  return `<nav class="tabs" aria-label="${escapeHtml(label)}">${items
    .map(
      (item) =>
        `<a href="${escapeHtml(item.href)}"${item.current === true ? ' aria-current="page"' : ""}>${escapeHtml(item.label)}${item.count === undefined ? "" : `<span class="n">${String(item.count)}</span>`}</a>`,
    )
    .join("")}</nav>`;
}

/** A segmented control of links, for a filter with few choices. `label` names the group. */
export function segmented(
  label: string,
  items: readonly { href: string; label: string; current?: boolean }[],
): string {
  return `<div class="seg" role="group" aria-label="${escapeHtml(label)}">${items
    .map(
      (item) =>
        `<a href="${escapeHtml(item.href)}"${item.current === true ? ' aria-current="true"' : ""}>${escapeHtml(item.label)}</a>`,
    )
    .join("")}</div>`;
}

/** Content folded under a summary line. `summary` is escaped; `body` must already be safe. */
export function fold(summary: string, body: string, open = false): string {
  return `<details class="fold"${open ? " open" : ""}><summary>${escapeHtml(summary)}</summary><div class="fold-body">${body}</div></details>`;
}

/** A menu entry: a link, a button that POSTs, or a button that opens a `dialog`. Labels are escaped. */
export type MenuItem =
  | { label: string; href: string }
  | { label: string; action: string; fields?: Record<string, string>; danger?: boolean }
  | { label: string; dialog: string; danger?: boolean };

/** A "..." menu of secondary actions. Nothing when it has no items. */
export function menu(items: readonly MenuItem[], label = "More actions"): string {
  if (items.length === 0) return "";
  const entries = items
    .map((item) => {
      if ("href" in item) {
        return `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`;
      }
      if ("dialog" in item) {
        return dialogButton(
          item.dialog,
          item.label,
          item.danger === true ? { variant: "danger" } : {},
        );
      }
      return `<form method="post" action="${escapeHtml(item.action)}">${hiddenFields(item.fields)}<button type="submit"${item.danger === true ? ' class="danger"' : ""}>${escapeHtml(item.label)}</button></form>`;
    })
    .join("");
  // Menus share a name so that opening one closes the last, which no script is there to do.
  return `<details class="menu" name="menu"><summary aria-label="${escapeHtml(label)}">${icon("dots")}</summary><div class="pop">${entries}</div></details>`;
}

export interface DialogOptions {
  /** Unique on the page; `dialogButton` opens it by this id. */
  id: string;
  /** Escaped. */
  title: string;
  /** Safe HTML: text and form fields. Give the first field `autofocus`. */
  body: string;
  /** Where the form POSTs. */
  action: string;
  /** Hidden form fields. */
  fields?: Record<string, string>;
  /** The submit button's text, escaped. */
  submit: string;
  /** Makes the submit button the destructive one. */
  danger?: boolean;
}

/**
 * A dialog that holds a POST form, as a popover so that it opens and closes
 * without a script. Put it anywhere on the page and open it with
 * `dialogButton`. A page that reloads itself closes it and drops typed text.
 */
export function dialog(options: DialogOptions): string {
  const id = escapeHtml(options.id);
  const close = `popovertarget="${id}" popovertargetaction="hide"`;
  return `<div class="dlg" id="${id}" popover role="dialog" aria-labelledby="${id}-title"><form method="post" action="${escapeHtml(options.action)}">${hiddenFields(options.fields)}<div class="dlg-head"><h2 id="${id}-title">${escapeHtml(options.title)}</h2><button type="button" class="icon-btn" ${close} aria-label="Close">${icon("close")}</button></div><div class="dlg-body">${options.body}</div><div class="dlg-foot"><button type="button" ${close}>Cancel</button><button type="submit" class="${options.danger === true ? "danger solid" : "primary"}">${escapeHtml(options.submit)}</button></div></form></div>`;
}

/** The button that opens the `dialog` with this id. `label` is escaped. */
export function dialogButton(
  id: string,
  label: string,
  options: { variant?: "primary" | "danger"; disabled?: boolean } = {},
): string {
  return `<button type="button"${options.variant === undefined ? "" : ` class="${options.variant}"`} popovertarget="${escapeHtml(id)}"${options.disabled === true ? " disabled" : ""}>${escapeHtml(label)}</button>`;
}

/** A two-column list of labels and values. Labels are escaped; values must already be safe HTML. */
export function keyValues(pairs: readonly (readonly [label: string, html: string])[]): string {
  return `<dl class="kv">${pairs
    .map(([label, html]) => `<dt>${escapeHtml(label)}</dt><dd>${html}</dd>`)
    .join("")}</dl>`;
}

export interface FieldNotes {
  /** Safe HTML under the control. */
  hint?: string | undefined;
  /** Why the server refused the value. Escaped, and announced. */
  error?: string | undefined;
}

/** The ids of a field's error and hint, for the control's aria-describedby. */
function describedBy(id: string, notes: FieldNotes): string {
  const ids = [
    notes.error === undefined ? "" : `${id}-err`,
    notes.hint === undefined ? "" : `${id}-hint`,
  ].filter((part) => part !== "");
  return `${notes.error === undefined ? "" : ' aria-invalid="true"'}${ids.length === 0 ? "" : ` aria-describedby="${escapeHtml(ids.join(" "))}"`}`;
}

/**
 * A label over any control, with an optional error and hint under it.
 * `control` must already be safe HTML and carry `id`; to tie the notes to it,
 * give it aria-describedby `<id>-err` and `<id>-hint`, as `input` does.
 */
export function field(id: string, label: string, control: string, notes: FieldNotes = {}): string {
  const safeId = escapeHtml(id);
  return `<div class="field"><label for="${safeId}">${escapeHtml(label)}</label>${control}${notes.error === undefined ? "" : `<p class="err" id="${safeId}-err" role="alert">${icon("x")}${escapeHtml(notes.error)}</p>`}${notes.hint === undefined ? "" : `<span class="hint" id="${safeId}-hint">${notes.hint}</span>`}</div>`;
}

export interface InputOptions extends FieldNotes {
  /** The control's id, when it must differ from its name. */
  id?: string;
  type?: "text" | "password" | "number" | "url" | "email" | "search";
  value?: string | undefined;
  placeholder?: string;
  maxlength?: number;
  autocomplete?: string;
  inputmode?: "numeric" | "decimal" | "url" | "email" | undefined;
  /** Defaults to true. */
  required?: boolean;
  autofocus?: boolean;
  /** The id of a datalist on the page that suggests values. */
  list?: string;
}

/** A labelled input, required unless told otherwise. */
export function input(name: string, label: string, options: InputOptions = {}): string {
  const id = options.id ?? name;
  const attributes = [
    `type="${options.type ?? "text"}"`,
    `id="${escapeHtml(id)}"`,
    `name="${escapeHtml(name)}"`,
    options.value === undefined ? "" : `value="${escapeHtml(options.value)}"`,
    options.placeholder === undefined ? "" : `placeholder="${escapeHtml(options.placeholder)}"`,
    options.maxlength === undefined ? "" : `maxlength="${String(options.maxlength)}"`,
    options.autocomplete === undefined ? "" : `autocomplete="${escapeHtml(options.autocomplete)}"`,
    options.inputmode === undefined ? "" : `inputmode="${options.inputmode}"`,
    options.list === undefined ? "" : `list="${escapeHtml(options.list)}"`,
    options.required === false ? "" : "required",
    options.autofocus === true ? "autofocus" : "",
  ].filter((part) => part !== "");
  return field(id, label, `<input ${attributes.join(" ")}${describedBy(id, options)}>`, options);
}

export interface TextareaOptions extends FieldNotes {
  id?: string;
  value?: string | undefined;
  rows?: number;
  maxlength?: number;
  placeholder?: string;
  /** Defaults to true. */
  required?: boolean;
  autofocus?: boolean;
  /** Extra classes, such as `config` for the tall JSON editor. */
  className?: string;
}

/** A labelled textarea, required unless told otherwise. */
export function textarea(name: string, label: string, options: TextareaOptions = {}): string {
  const id = options.id ?? name;
  const attributes = [
    `id="${escapeHtml(id)}"`,
    `name="${escapeHtml(name)}"`,
    options.className === undefined ? "" : `class="${escapeHtml(options.className)}"`,
    options.rows === undefined ? "" : `rows="${String(options.rows)}"`,
    options.placeholder === undefined ? "" : `placeholder="${escapeHtml(options.placeholder)}"`,
    options.maxlength === undefined ? "" : `maxlength="${String(options.maxlength)}"`,
    options.required === false ? "" : "required",
    options.autofocus === true ? "autofocus" : "",
  ].filter((part) => part !== "");
  return field(
    id,
    label,
    `<textarea ${attributes.join(" ")}${describedBy(id, options)}>${escapeHtml(options.value ?? "")}</textarea>`,
    options,
  );
}

export interface SelectOptions extends FieldNotes {
  id?: string;
  disabled?: boolean;
}

/** A select with no label of its own, for a row that labels it another way. Option text is escaped. */
export function selectControl(
  name: string,
  options: readonly (readonly [value: string, text: string])[],
  value: string,
  extra: { id?: string; disabled?: boolean; describedBy?: string } = {},
): string {
  return `<select id="${escapeHtml(extra.id ?? name)}" name="${escapeHtml(name)}"${extra.disabled === true ? " disabled" : ""}${extra.describedBy ?? ""}>${options
    .map(
      ([option, text]) =>
        `<option value="${escapeHtml(option)}"${option === value ? " selected" : ""}>${escapeHtml(text)}</option>`,
    )
    .join("")}</select>`;
}

/** A labelled select with `value` selected. */
export function select(
  name: string,
  label: string,
  options: readonly (readonly [value: string, text: string])[],
  value: string,
  extra: SelectOptions = {},
): string {
  const id = extra.id ?? name;
  return field(
    id,
    label,
    selectControl(name, options, value, {
      id,
      ...(extra.disabled === true ? { disabled: true } : {}),
      describedBy: describedBy(id, extra),
    }),
    extra,
  );
}

/** A checkbox inside its label. The box sends `value` (default "1") when ticked. */
export function checkbox(
  name: string,
  label: string,
  options: { checked?: boolean; value?: string; disabled?: boolean } = {},
): string {
  return `<label class="check"><input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(options.value ?? "1")}"${options.checked === true ? " checked" : ""}${options.disabled === true ? " disabled" : ""}>${escapeHtml(label)}</label>`;
}

/**
 * A settings row: the label and hint at the left, the control at the right.
 * `label` is escaped; `hint` and `control` must already be safe, and `control` carries `id`.
 */
export function setting(id: string, label: string, hint: string, control: string): string {
  return `<div class="setting"><div><label for="${escapeHtml(id)}">${escapeHtml(label)}</label><span class="hint">${hint}</span></div>${control}</div>`;
}

/** The row at the foot of a form that holds its submit button and what saving does. */
export function saveBar(html: string): string {
  return `<div class="savebar">${html}</div>`;
}

export interface ButtonOptions {
  /** Hidden form fields. */
  fields?: Record<string, string>;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
}

/** A form with one button that POSTs to `action`. `label` is escaped. */
export function postButton(action: string, label: string, options: ButtonOptions = {}): string {
  const variant =
    options.variant === undefined || options.variant === "secondary"
      ? ""
      : ` class="${options.variant}"`;
  return `<form class="inline" method="post" action="${escapeHtml(action)}">${hiddenFields(options.fields)}<button type="submit"${variant}${options.disabled === true ? " disabled" : ""}>${escapeHtml(label)}</button></form>`;
}

/** A link styled as a button, such as one that opens a form on a page of its own. `label` is escaped. */
export function buttonLink(
  href: string,
  label: string,
  options: { variant?: "primary" | "danger" } = {},
): string {
  return `<a class="btn${options.variant === undefined ? "" : ` ${options.variant}`}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

/** A link to a page outside the dashboard, such as GitHub. It opens in a new tab and says so. */
export function externalLink(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}${icon("ext")}<span class="sr-only"> (opens in a new tab)</span></a>`;
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
