import { ConfigValidationError, type FactoryConfig } from "../config/document.js";
import type { ConfigVersion } from "../config/store.js";
import type { FactoryPages } from "./factory.js";
import {
  backTo,
  callout,
  checkbox,
  dialog,
  dialogButton,
  escapeHtml,
  icon,
  input,
  layout,
  pageHead,
  saveBar,
  tabs,
  type Crumb,
  type Shell,
} from "./html.js";
import { readBody, redirect, sendHtml, type Route, type RouteContext } from "./http.js";
import { publishVersion } from "./versions.js";

export type ConfigTab = "factory" | "models" | "agents" | "versions" | "json";

const TABS: readonly (readonly [ConfigTab, string, string])[] = [
  ["factory", "/config", "Factory"],
  ["models", "/config/models", "Models"],
  ["agents", "/config/agents", "Agents"],
  ["versions", "/config/versions", "Versions"],
  ["json", "/config/json", "JSON"],
];

const REPO_DIALOG = "config-repo";
const REPO_PATH = "/config/repo";
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REPO_HINT =
  "As owner/name. Workers fetch config versions from it. Hephaestus creates it, private, on the first deploy.";

/** What every form that edits the config posts at most, besides a whole config. */
export const MAX_FORM_BYTES = 64 * 1024;

export const STALE =
  "The config changed since the page was loaded. Check what you changed and save again.";

/**
 * The config repo above the tabs: its name with a Change dialog, or a warning
 * that holds the form while none is named. Nothing deploys without one, so it
 * shows on every tab.
 */
function repoRow(factory: FactoryPages, back: string): string {
  if (factory.configRepo === undefined) return "";
  const slug = factory.configRepo();
  const canChange = factory.setConfigRepo !== undefined;
  if (slug === undefined || slug === "") {
    return callout(
      "warn",
      "Name the config repo",
      "Hephaestus pushes each deployed config version to a private GitHub repo, and workers fetch it from there. Nothing deploys until one is named. Hephaestus creates the repo, private, on the first deploy.",
      canChange
        ? `<form class="repo-form" method="post" action="${REPO_PATH}"><input type="hidden" name="back" value="${escapeHtml(back)}">${input("slug", "Private config repo, as owner/name", { placeholder: "owner/hephaestus-config" })}<button type="submit" class="primary">Save repo</button></form>`
        : "",
    );
  }
  const change = canChange
    ? `<div class="aside">${dialogButton(REPO_DIALOG, "Change")}</div>${dialog({
        id: REPO_DIALOG,
        title: "Config repo",
        body: input("slug", "Private config repo", { value: slug, hint: REPO_HINT }),
        action: REPO_PATH,
        fields: { back },
        submit: "Save repo",
      })}`
    : "";
  return `<div class="row repo-row"><div class="main"><span class="subline">Config repo</span><code>${escapeHtml(slug)}</code></div>${change}</div>`;
}

/** One Config tab: the page head, the config repo, the tabs, then `body`. */
export function configTab(
  factory: FactoryPages,
  context: RouteContext,
  tab: ConfigTab,
  body: string,
): string {
  const here = TABS.find(([name]) => name === tab)?.[1] ?? "/config";
  return layout(
    "Config",
    `${pageHead({
      title: "Config",
      lede: "Limits, models, instructions, and schedules. Every save is a numbered version you can revert.",
    })}${repoRow(factory, here)}${tabs(
      TABS.map(([name, href, label]) => ({ href, label, current: name === tab })),
      "Config sections",
    )}${body}`,
    { section: "/config", shell: context.shell },
  );
}

/** A Config page that is not a tab: a drill-in, or an answer to an action that did not work. */
export function configPage(
  shell: Shell | undefined,
  title: string,
  body: string,
  crumbs?: readonly Crumb[],
): string {
  return layout(title, body, {
    section: "/config",
    shell,
    ...(crumbs === undefined ? {} : { crumbs }),
  });
}

/** A page that says an action did not happen, with a way back. `backLabel` is escaped. */
export function refusal(
  shell: Shell | undefined,
  title: string,
  reason: string,
  back: string,
  backLabel: string,
): string {
  return configPage(
    shell,
    title,
    `${pageHead({ title })}${callout("err", title, escapeHtml(reason))}<p><a href="${escapeHtml(back)}">${escapeHtml(backLabel)}</a></p>`,
  );
}

/** An error callout that lists why a save was refused. `title` and `errors` are escaped. */
export function problems(title: string, errors: readonly string[] | undefined): string {
  if (errors === undefined || errors.length === 0) return "";
  const [first = ""] = errors;
  if (errors.length === 1) return callout("err", title, escapeHtml(first));
  return `<div class="box err" role="alert"><div class="box-title">${icon("x")}<span>${escapeHtml(title)}</span></div><ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div>`;
}

/** The callout a page shows after a save that deployed, from the `saved` query the save redirects with. */
export function savedNotice(url: URL): string {
  const id = url.searchParams.get("saved") ?? "";
  return /^\d{1,9}$/.test(id)
    ? callout(
        "info",
        "Saved",
        `Version ${id} is deployed. <a href="/config/versions/${id}">See what changed</a>.`,
      )
    : "";
}

/** The Deploy now choice, ticked unless a refused form came back without it. */
export function deployChoice(submitted: URLSearchParams | undefined): string {
  return checkbox("deploy", "Deploy now", {
    value: "on",
    checked: submitted === undefined || submitted.get("deploy") === "on",
  });
}

/** The foot of a form that saves a config version built from `base`. `label` is escaped. */
export function versionSaveBar(
  label: string,
  base: ConfigVersion,
  submitted: URLSearchParams | undefined,
): string {
  return saveBar(
    `<button type="submit" class="primary">${escapeHtml(label)}</button>${deployChoice(submitted)}<span class="hint">Creates a config version built from version ${String(base.id)}.</span>`,
  );
}

/** A posted form's fields, or undefined after answering that the form is too large. */
export async function readForm(
  context: RouteContext,
  limit = MAX_FORM_BYTES,
): Promise<URLSearchParams | undefined> {
  const body = await readBody(context.request, limit);
  if (body === undefined) {
    sendHtml(
      context.response,
      413,
      refusal(
        context.shell,
        "Too large",
        "The form is too large to save.",
        "/config",
        "Back to Config",
      ),
    );
    return undefined;
  }
  return new URLSearchParams(body);
}

/** A form field's text with the line ends a browser sends turned back into plain newlines. */
export function formText(form: URLSearchParams, name: string): string {
  return (form.get(name) ?? "").replace(/\r\n?/g, "\n");
}

/** The version a form was built from, when it is still the one edits build on. */
export function baseOf(factory: FactoryPages, form: URLSearchParams): ConfigVersion | undefined {
  const base = factory.store.current();
  return base !== undefined && String(base.id) === (form.get("parentId") ?? "") ? base : undefined;
}

export interface Save {
  document: FactoryConfig;
  message: string;
  base: ConfigVersion;
  form: URLSearchParams;
  /** Where to go once the version is deployed; the version's number is added as `saved`. */
  saved: string;
}

/**
 * Saves `document` as a version, deploys it when the form asks, and redirects:
 * to `saved` once deployed, else to the version's page, which says what is
 * left to do. Returns the reasons instead when the config refuses the document.
 */
export async function saveVersion(
  factory: FactoryPages,
  context: RouteContext,
  save: Save,
): Promise<string[] | undefined> {
  let published;
  try {
    published = await publishVersion({
      store: factory.store,
      deploy: factory.deploy,
      document: save.document,
      message: save.message,
      parentId: save.base.id,
      deployNow: save.form.get("deploy") === "on",
    });
  } catch (error) {
    if (error instanceof ConfigValidationError) return error.problems;
    if (error instanceof Error) return [error.message];
    throw error;
  }
  const page = `/config/versions/${String(published.id)}`;
  if (published.state === "deploy-failed") redirect(context.response, `${page}?deploy=failed`);
  else if (published.state !== "deployed") redirect(context.response, page);
  else if (published.hermesError !== undefined) redirect(context.response, `${page}?hermes=failed`);
  else {
    redirect(
      context.response,
      `${save.saved}${save.saved.includes("?") ? "&" : "?"}saved=${String(published.id)}`,
    );
  }
  return undefined;
}

/** Names the config repo, from the form above the tabs. */
export function configRepoRoutes(factory: FactoryPages): Route[] {
  return [
    {
      method: "POST",
      path: /^\/config\/repo$/,
      handle: async (context) => {
        const form = await readForm(context, 4096);
        if (form === undefined) return;
        const slug = form.get("slug")?.trim() ?? "";
        const back = backTo(form.get("back"), "/config");
        if (factory.setConfigRepo === undefined || !REPO.test(slug)) {
          sendHtml(
            context.response,
            400,
            refusal(
              context.shell,
              "Config repo not saved",
              "Name the repo as owner/name.",
              back,
              "Back to Config",
            ),
          );
          return;
        }
        factory.setConfigRepo(slug);
        redirect(context.response, back);
      },
    },
  ];
}
