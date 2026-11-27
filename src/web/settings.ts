import { ConfigValidationError, MAX_CONFIG_BYTES, type FactoryConfig } from "../config/document.js";
import { agentsRoutes } from "./agents.js";
import { codingModelsRoutes } from "./coding-models.js";
import {
  STALE,
  baseOf,
  configRepoRoutes,
  configTab,
  problems,
  readForm,
  saveVersion,
  savedNotice,
  versionSaveBar,
} from "./config-page.js";
import { applyLimitsAndSchedules, limitsAndSchedulesFields } from "./factory-settings.js";
import type { FactoryPages } from "./factory.js";
import { empty, escapeHtml, field, input } from "./html.js";
import { redirect, sendHtml, type Route, type RouteContext } from "./http.js";
import { modelRoutes } from "./model.js";
import { versionRoutes } from "./version-pages.js";

export type { Deploy } from "./versions.js";

/**
 * Form encoding at most triples a config's UTF-8 bytes, so this fits any
 * config up to MAX_CONFIG_BYTES plus the rest of the form.
 */
const MAX_EDIT_BYTES = 3 * MAX_CONFIG_BYTES + 64 * 1024;

/** What a refused JSON edit comes back with, so the owner can correct it. */
interface Draft {
  text: string;
  parentId: string;
  message: string;
  errors: string[];
}

/** The Config page: the factory's settings by tab, each save a config version. */
export function configRoutes(factory: FactoryPages): Route[] {
  const { store } = factory;
  return [
    {
      method: "GET",
      path: /^\/config$/,
      handle: (context) => {
        factoryTab(context);
      },
    },
    { method: "POST", path: /^\/config\/factory$/, handle: (context) => saveFactory(context) },
    {
      method: "GET",
      path: /^\/config\/json$/,
      handle: (context) => {
        jsonTab(context);
      },
    },
    { method: "POST", path: /^\/config\/json$/, handle: (context) => saveJson(context) },
    ...configRepoRoutes(factory),
    ...codingModelsRoutes(factory),
    ...modelRoutes(factory),
    ...agentsRoutes(factory),
    ...versionRoutes(factory),
  ];

  function factoryTab(context: RouteContext, errors?: string[], submitted?: URLSearchParams): void {
    const current = store.current();
    const body =
      current === undefined
        ? empty("No config version yet.")
        : `${savedNotice(context.url)}${problems("Not saved", errors)}<form method="post" action="/config/factory"><input type="hidden" name="parentId" value="${String(current.id)}">${limitsAndSchedulesFields(current.document, submitted)}${versionSaveBar("Save settings", current, submitted)}</form>`;
    sendHtml(
      context.response,
      errors === undefined ? 200 : 400,
      configTab(factory, context, "factory", body),
    );
  }

  async function saveFactory(context: RouteContext): Promise<void> {
    const form = await readForm(context);
    if (form === undefined) return;
    const base = baseOf(factory, form);
    if (base === undefined) {
      factoryTab(context, [STALE]);
      return;
    }
    const applied = applyLimitsAndSchedules(base.document, form);
    const errors =
      applied.errors.length > 0
        ? applied.errors
        : saveVersion(factory, context, {
            document: applied.config,
            message: "Change the factory settings",
            base,
            form,
            saved: "/config",
          });
    if (errors !== undefined) factoryTab(context, errors, form);
  }

  function jsonTab(context: RouteContext, draft?: Draft): void {
    const current = store.current();
    // A refused edit keeps the version it was built from, so retrying cannot change its base.
    const parentId = draft?.parentId ?? (current === undefined ? "" : String(current.id));
    const text = draft?.text ?? editorText(current?.document ?? {});
    const editor = field(
      "document",
      "Config",
      `<textarea id="document" class="config" name="document" spellcheck="false">${escapeHtml(text)}</textarea>`,
    );
    sendHtml(
      context.response,
      draft === undefined ? 200 : 400,
      configTab(
        factory,
        context,
        "json",
        `${problems("The draft was not saved", draft?.errors)}<form class="form wide" method="post" action="/config/json"><p class="muted">The whole config as JSON, for changes the other tabs do not cover. Saving creates a draft built from version ${parentId === "" ? "none" : escapeHtml(parentId)}. Nothing changes until the draft is approved and deployed.</p><input type="hidden" name="parentId" value="${escapeHtml(parentId)}">${input("message", "What changed", { value: draft?.message ?? "" })}${editor}<div><button type="submit" class="primary">Save as a draft</button></div></form>`,
      ),
    );
  }

  async function saveJson(context: RouteContext): Promise<void> {
    const form = await readForm(context, MAX_EDIT_BYTES, {
      reason: `A config holds at most ${String(MAX_CONFIG_BYTES / 1024 / 1024)} MB as JSON, and this one is larger.`,
      back: "/config/json",
      backLabel: "Back to the JSON tab",
    });
    if (form === undefined) return;
    const text = form.get("document") ?? "";
    const parent = form.get("parentId") ?? "";
    const message = form.get("message") ?? "";
    const refuse = (errors: string[]): void => {
      jsonTab(context, { text, parentId: parent, message, errors });
    };
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch (error) {
      refuse([`The config is not valid JSON: ${String(error)}`]);
      return;
    }
    try {
      const version = store.createVersion({
        document: document as FactoryConfig,
        author: "owner",
        message,
        ...(parent === "" ? {} : { parentId: Number(parent) }),
      });
      redirect(context.response, `/config/versions/${String(version.id)}`);
    } catch (error) {
      if (error instanceof ConfigValidationError) refuse(error.problems);
      else if (error instanceof Error) refuse([error.message]);
      else throw error;
    }
  }
}

/** Pretty JSON for the editor, or compact JSON when pretty JSON could exceed the form limit. */
function editorText(document: unknown): string {
  const pretty = JSON.stringify(document, null, 2);
  return 3 * Buffer.byteLength(pretty) + 64 * 1024 <= MAX_EDIT_BYTES
    ? pretty
    : JSON.stringify(document);
}
