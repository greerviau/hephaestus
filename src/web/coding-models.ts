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
import { applyCodingModels, codingModelsFields } from "./factory-settings.js";
import type { FactoryPages } from "./factory.js";
import { buttonLink, empty, escapeHtml, section, statusText } from "./html.js";
import { sendHtml, type Route, type RouteContext } from "./http.js";
import { PLANNING_PATH, planningState } from "./model.js";

/** The Models tab: the planning and chat model in use, and a form for the models the coding jobs run. */
export function codingModelsRoutes(factory: FactoryPages): Route[] {
  return [
    { method: "GET", path: /^\/config\/models$/, handle: (context) => show(context) },
    { method: "POST", path: /^\/config\/models$/, handle: (context) => save(context) },
  ];

  async function show(
    context: RouteContext,
    errors?: string[],
    submitted?: URLSearchParams,
  ): Promise<void> {
    const current = factory.store.current();
    const coding =
      current === undefined
        ? empty("No config version yet.")
        : `${problems("Not saved", errors)}<form method="post" action="/config/models"><input type="hidden" name="parentId" value="${String(current.id)}">${codingModelsFields(current.document, submitted)}${versionSaveBar("Save coding models", current, submitted)}</form>`;
    sendHtml(
      context.response,
      errors === undefined ? 200 : 400,
      configTab(
        factory,
        context,
        "models",
        `${savedNotice(context.url)}${await planning(factory)}${coding}`,
      ),
    );
  }

  async function save(context: RouteContext): Promise<void> {
    const form = await readForm(context);
    if (form === undefined) return;
    const base = baseOf(factory, form);
    if (base === undefined) {
      await show(context, [STALE]);
      return;
    }
    const applied = applyCodingModels(base.document, form);
    const errors =
      applied.errors.length > 0
        ? applied.errors
        : await saveVersion(factory, context, {
            document: applied.config,
            message: "Change the coding models",
            base,
            form,
            saved: "/config/models",
          });
    if (errors !== undefined) await show(context, errors, form);
  }
}

/** The Planning and chat section: one row that says what is in use and links to the page that changes it. */
async function planning(factory: FactoryPages): Promise<string> {
  const found = await planningState(factory.model);
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
  return section({
    title: "Planning and chat",
    body: `<ul class="rows"><li class="row job"><div class="main"><span class="title">Plan, brief, and chat</span><span class="subline">Decides what to work on, writes each task's brief, and answers you in chat. Runs on this host.</span></div><div class="aside">${aside}</div></li></ul><p class="hint note">Saved on its own and takes effect at once. It is not part of a config version.</p>`,
  });
}
