import {
  STALE,
  baseOf,
  configTab,
  problems,
  readForm,
  saveVersion,
  savedNotice,
  versionSaveBar,
} from "./config-page.js";
import type { EffortProvider } from "../config/effort.js";
import { applyCodingModels, codingModelsFields, unavailableProviders } from "./factory-settings.js";
import { read, type FactoryPages } from "./factory.js";
import { buttonLink, empty, escapeHtml, section, statusText } from "./html.js";
import { sendHtml, type Route, type RouteContext } from "./http.js";
import { LAZY_SCRIPT_TAG } from "./lazy.js";
import { PROVIDER_CHOICE_SCRIPT_TAG } from "./provider-choice.js";
import {
  PLANNING_PATH,
  PLANNING_SUMMARY_PATH,
  cachedPlanningState,
  type PlanningState,
} from "./model.js";

/** The Models tab: the planning and chat model in use, and a form for the models the coding jobs run. */
export function codingModelsRoutes(factory: FactoryPages): Route[] {
  return [
    {
      method: "GET",
      path: /^\/config\/models$/,
      handle: (context) => {
        show(context);
      },
    },
    { method: "POST", path: /^\/config\/models$/, handle: (context) => save(context) },
    {
      method: "GET",
      path: /^\/config\/models\/planning\/summary$/,
      handle: async (context) => {
        const found = await cachedPlanningState(
          factory.model,
          (factory.now ?? Date.now)(),
          context.url.searchParams.get("refresh") === "1",
        );
        sendHtml(context.response, 200, planningAside(found));
      },
    },
  ];

  /** The providers no worker has signed in; none when the workers cannot be read. */
  function unavailable(): EffortProvider[] {
    const views = read("workers", () => factory.workers?.views() ?? []);
    return views.ok ? unavailableProviders(views.value) : [];
  }

  function show(context: RouteContext, errors?: string[], submitted?: URLSearchParams): void {
    const current = factory.store.current();
    const coding =
      current === undefined
        ? empty("No config version yet.")
        : `${problems("Not saved", errors)}<form method="post" action="/config/models"><input type="hidden" name="parentId" value="${String(current.id)}">${codingModelsFields(current.document, submitted, unavailable())}${versionSaveBar("Save coding models", current, submitted)}</form>${PROVIDER_CHOICE_SCRIPT_TAG}`;
    sendHtml(
      context.response,
      errors === undefined ? 200 : 400,
      configTab(
        factory,
        context,
        "models",
        `${savedNotice(context.url)}${planning(factory)}${coding}${LAZY_SCRIPT_TAG}`,
      ),
    );
  }

  async function save(context: RouteContext): Promise<void> {
    const form = await readForm(context);
    if (form === undefined) return;
    const base = baseOf(factory, form);
    if (base === undefined) {
      show(context, [STALE]);
      return;
    }
    const applied = applyCodingModels(base.document, form);
    const errors =
      applied.errors.length > 0
        ? applied.errors
        : saveVersion(factory, context, {
            document: applied.config,
            message: "Change the coding models",
            base,
            form,
            saved: "/config/models",
          });
    if (errors !== undefined) show(context, errors, form);
  }
}

/**
 * The Planning and chat section. Reading the model asks Hermes, which is slow,
 * so the row renders at once and its right side loads after the page is up.
 * Without a ready Hermes there is nothing to wait for and the row says so now.
 */
function planning(factory: FactoryPages): string {
  const { model } = factory;
  const ready = model !== undefined && model.ready();
  const aside = ready
    ? `<div class="aside" data-lazy-url="${PLANNING_SUMMARY_PATH}" aria-busy="true"><span class="muted">Loading the model in use...</span><noscript>${buttonLink(PLANNING_PATH, "Open")}</noscript></div>`
    : `<div class="aside">${planningAside({ state: model === undefined ? "absent" : "not-ready" })}</div>`;
  return section({
    title: "Planning and chat",
    body: `<ul class="rows"><li class="row job"><div class="main"><span class="title">Plan, brief, and chat</span><span class="subline">Runs on this host. Takes effect at once, outside config versions.</span></div>${aside}</li></ul>`,
  });
}

/** What the right side of the Planning and chat row says. */
function planningAside(found: PlanningState): string {
  let aside: string;
  if (found.state === "set") {
    const signedIn =
      found.signedIn === undefined
        ? ""
        : found.signedIn
          ? statusText("done", "Signed in")
          : statusText("you", "Not signed in");
    aside = `<span><strong>${escapeHtml(found.model)}</strong> <span class="muted">${escapeHtml(found.provider)}</span></span>${signedIn}${buttonLink(PLANNING_PATH, "Change")}`;
  } else if (found.state === "absent") {
    aside =
      '<span class="muted">This install has no factory Hermes, so there is no model to set.</span>';
  } else if (found.state === "not-ready") {
    aside = `${statusText("wait", "Not ready yet")}<span class="muted">Deploy a config version first.</span>`;
  } else if (found.state === "down") {
    aside = `${statusText("bad", "Hermes did not answer")}${buttonLink(PLANNING_PATH, "Open")}`;
  } else {
    aside = `${statusText("you", "Not set")}${buttonLink(PLANNING_PATH, "Set up", { variant: "primary" })}`;
  }
  // Those two answer without Hermes, so a refresh would change nothing.
  return found.state === "absent" || found.state === "not-ready"
    ? aside
    : `${aside}<button type="button" class="link" data-lazy-refresh>Refresh</button>`;
}
