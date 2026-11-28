import {
  ModelError,
  ModelPartial,
  ModelWarning,
  type DeviceLogin,
  type ModelCatalog,
  type ProviderRow,
} from "../hermes/factory-model.js";
import { RestartError } from "../messaging.js";
import { configPage } from "./config-page.js";
import type { FactoryPages } from "./factory.js";
import {
  buttonLink,
  callout,
  checkbox,
  empty,
  escapeHtml,
  externalLink,
  field,
  input,
  layout,
  lookup,
  modelSelect,
  pageHead,
  section,
  selectControl,
  statusText,
} from "./html.js";
import { readBody, redirect, sendHtml, type Route, type RouteContext } from "./http.js";
import { LAZY_SCRIPT_PATH } from "./lazy.js";

const MAX_FORM_BYTES = 16 * 1024;
/** The page that sets the planning and chat model, a drill-in of the Models tab. */
export const PLANNING_PATH = "/config/models/planning";
/** The fragment the Models tab loads after it renders: what the planning and chat row says. */
export const PLANNING_SUMMARY_PATH = "/config/models/planning/summary";
const TITLE = "Planning and chat model";
const CRUMBS = [
  ["Config", "/config"],
  ["Models", "/config/models"],
  ["Planning and chat"],
] as const;

const NOTICES: Record<string, { title: string; text: string }> = {
  key: {
    title: "Key saved",
    text: "The factory Hermes can use this provider now. Pick a model below.",
  },
  saved: {
    title: "Model saved",
    text: "The factory's chat restarted with it, so the next request uses it.",
  },
};

/** What a form that stopped on a warning comes back with. */
interface Warned {
  model: string;
  /** The endpoint URL to show again; undefined when it held a user name or password. */
  baseUrl: string | undefined;
}

/** Why a change did not happen; a warning keeps what the owner typed so they can save it anyway. */
type Problem = {
  text: string;
  warning?: Warned;
  /** The change was saved but the gateway did not restart. */
  saved?: boolean;
  /** Hermes refused partway, after some of the factory was written. */
  partial?: boolean;
};

type Model = NonNullable<FactoryPages["model"]>;

const HIDDEN = "[hidden]";

/** The user name and password in a URL's address, each as typed and as it reads decoded. */
function urlCredentials(text: string): string[] {
  let parts: string[];
  try {
    const url = new URL(text);
    parts = [url.username, url.password];
  } catch {
    // Not a URL a browser sends from the form; whatever sits before an @ is treated as a secret.
    const at = text.lastIndexOf("@");
    parts = at < 0 ? [] : text.slice(text.indexOf("://") + 1, at).split(":");
  }
  return parts
    .filter((part) => part.replace(/^\/+/, "") !== "")
    .flatMap((part) => {
      const typed = part.replace(/^\/+/, "");
      try {
        return [typed, decodeURIComponent(typed)];
      } catch {
        return [typed];
      }
    });
}

/**
 * `text` without the secrets the form sent. An endpoint URL may carry a user
 * name and password, which Hermes stores with the URL, and Hermes's reply can
 * quote the URL or the key; neither may reach the page.
 */
function withoutSecrets(text: string, secrets: readonly string[]): string {
  const longestFirst = [...new Set(secrets)].sort((a, b) => b.length - a.length);
  let shown = text;
  for (const secret of longestFirst) {
    // The whole user:password pair reads as one hidden part, then any that stand alone.
    shown = shown.replaceAll(secret, HIDDEN);
  }
  return shown.replaceAll(`${HIDDEN}:${HIDDEN}`, HIDDEN);
}

/** What the Models tab says about the planning and chat model. */
export type PlanningState =
  | { state: "absent" | "not-ready" | "down" | "unset" }
  | { state: "set"; model: string; provider: string; signedIn: boolean | undefined };

/** Reads the model in use and whether its provider is signed in. A custom endpoint has no sign-in. */
export async function planningState(model: Model | undefined): Promise<PlanningState> {
  if (model === undefined) return { state: "absent" };
  if (!model.ready()) return { state: "not-ready" };
  let catalog: ModelCatalog;
  try {
    catalog = await model.catalog();
  } catch (error) {
    console.error("Reading the model catalog failed", error);
    return { state: "down" };
  }
  if (catalog.provider === "" || catalog.model === "") return { state: "unset" };
  return {
    state: "set",
    model: catalog.model,
    provider: providerName(catalog, catalog.provider),
    signedIn:
      catalog.provider === "custom"
        ? undefined
        : (catalog.providers.find((row) => row.slug === catalog.provider)?.authenticated ?? false),
  };
}

/** How long the Models tab trusts the last answer from Hermes. */
const PLANNING_TTL_MS = 60_000;

interface Remembered {
  at: number;
  state: Promise<PlanningState>;
}

const remembered = new WeakMap<object, Remembered>();

/**
 * `planningState`, remembered for a minute, because Hermes answers by running
 * a subprocess that takes seconds. An answer that said Hermes was down is not
 * kept, so the next read tries again. `refresh` reads again regardless.
 */
export function cachedPlanningState(
  model: Model | undefined,
  now: number,
  refresh = false,
): Promise<PlanningState> {
  // These two answer without Hermes, so there is nothing to remember.
  if (model === undefined || !model.ready()) return planningState(model);
  const hit = remembered.get(model);
  if (!refresh && hit !== undefined && now - hit.at < PLANNING_TTL_MS) return hit.state;
  const entry: Remembered = { at: now, state: planningState(model) };
  remembered.set(model, entry);
  void entry.state.then((found) => {
    if (found.state === "down" && remembered.get(model) === entry) remembered.delete(model);
  });
  return entry.state;
}

/** Drops the remembered answer, for a change that makes it wrong. */
export function forgetPlanningState(model: Model | undefined): void {
  if (model !== undefined) remembered.delete(model);
}

/** The planning and chat model page: give the factory Hermes a provider and model, with any provider Hermes supports. */
export function modelRoutes(factory: FactoryPages): Route[] {
  const model = factory.model;
  return [
    {
      method: "GET",
      path: /^\/config\/models\/planning$/,
      handle: async (context) => {
        const { response, url } = context;
        const notice = url.searchParams.get("notice") ?? "";
        const chosen = url.searchParams.get("provider") ?? "";
        sendHtml(response, 200, await page(context, chosen, notice, undefined));
      },
    },
    {
      method: "POST",
      path: /^\/config\/models\/planning\/(key|login|set)$/,
      handle: (context) => act(context),
    },
  ];

  async function act(context: RouteContext): Promise<void> {
    const { request, response, params } = context;
    const body = await readBody(request, MAX_FORM_BYTES);
    if (model === undefined || body === undefined) {
      redirect(response, PLANNING_PATH);
      return;
    }
    const form = new URLSearchParams(body);
    const provider = form.get("provider") ?? "";
    const back = `${PLANNING_PATH}?provider=${encodeURIComponent(provider)}`;
    const baseUrl = form.get("base_url")?.trim() ?? "";
    const credentials = urlCredentials(baseUrl);
    const key = form.get("key")?.trim() ?? "";
    const shown = (text: string): string =>
      withoutSecrets(text, [...credentials, ...(key === "" ? [] : [key])]);
    try {
      if (provider === "") throw new ModelError("Pick a provider first.");
      if (params[0] === "key") {
        await model.addKey(provider, form.get("key") ?? "");
        redirect(response, `${back}&notice=key`);
      } else if (params[0] === "login") {
        await model.startDeviceLogin(provider);
        redirect(response, back);
      } else {
        const chosen = form.get("model") ?? "";
        try {
          await model.setModel({
            provider,
            model: chosen,
            ...(baseUrl === "" ? {} : { baseUrl }),
            ...(key === "" ? {} : { key }),
            ...(form.get("force") === "on" ? { force: true } : {}),
          });
        } catch (error) {
          if (!(error instanceof ModelWarning)) throw error;
          const problem = {
            text: shown(error.message),
            warning: { model: chosen, baseUrl: credentials.length === 0 ? baseUrl : undefined },
          };
          sendHtml(response, 400, await page(context, provider, "", problem));
          return;
        }
        redirect(response, `${back}&notice=saved`);
      }
    } catch (error) {
      if (error instanceof RestartError) {
        sendHtml(
          response,
          400,
          await page(context, provider, "", { text: shown(error.message), saved: true }),
        );
        return;
      }
      sendHtml(
        response,
        400,
        await page(context, provider, "", {
          text: shown(messageOf(error)),
          ...(error instanceof ModelPartial ? { partial: true } : {}),
        }),
      );
    } finally {
      // Even a refused or partial change may have written part of the model.
      forgetPlanningState(model);
    }
  }

  async function page(
    context: RouteContext,
    chosen: string,
    notice: string,
    problem: Problem | undefined,
  ): Promise<string> {
    const { shell } = context;
    const head = pageHead({ title: TITLE });
    if (model === undefined) {
      return configPage(
        shell,
        TITLE,
        `${head}${empty("This install has no factory Hermes, so there is no model to set.")}`,
        CRUMBS,
      );
    }
    if (!model.ready()) {
      return configPage(
        shell,
        TITLE,
        `${head}${callout("info", "Not ready yet", 'Deploy a config version on <a href="/config/versions">Config</a> first; it sets up the factory\'s Hermes.')}`,
        CRUMBS,
      );
    }
    let catalog: ModelCatalog;
    try {
      catalog = await model.catalog();
    } catch (error) {
      return configPage(
        shell,
        TITLE,
        `${head}${callout("err", "Hermes did not answer", escapeHtml(messageOf(error)), buttonLink(PLANNING_PATH, "Reload"))}`,
        CRUMBS,
      );
    }
    const login = model.deviceLogin();
    const provider =
      catalog.providers.find((row) => row.slug === chosen) ??
      catalog.providers.find((row) => row.slug === catalog.provider) ??
      catalog.providers[0];
    const shown = lookup(NOTICES, notice);
    const waiting = login?.status === "waiting" && login.provider === provider?.slug;
    // An error page is rendered at the POST's address, which has no GET route to refresh to.
    const refresh = waiting && problem === undefined;
    const body = `${head}${shown === undefined ? "" : callout("info", shown.title, escapeHtml(shown.text))}${
      problem === undefined ? "" : problemCallout(problem)
    }${inUse(catalog)}${providerSection(catalog, provider)}${
      provider === undefined ? "" : signInSection(catalog, provider, login)
    }${
      provider === undefined
        ? ""
        : refresh
          ? // The page reloads while it waits for the sign-in, which would drop a model name being typed.
            section({
              title: "3. Model",
              body: '<div class="step"><p class="muted">Choose a model here once the sign-in finishes.</p></div>',
            })
          : modelSection(catalog, provider, problem?.warning)
    }`;
    // A page that changes the model drops the Models tab's copy of what it shows.
    return layout(
      TITLE,
      `${body}<script src="${LAZY_SCRIPT_PATH}" data-lazy-forget="${PLANNING_SUMMARY_PATH}" defer></script>`,
      {
        section: "/config",
        shell,
        crumbs: CRUMBS,
        ...(refresh ? { refreshSeconds: 5 } : {}),
      },
    );
  }
}

function problemCallout(problem: Problem): string {
  if (problem.saved === true) {
    return callout(
      "err",
      "Saved, but the chat did not restart",
      `${escapeHtml(problem.text)} Restart it on <a href="/chat">Chat</a>.`,
    );
  }
  if (problem.partial === true) {
    return callout(
      "err",
      "Partly saved",
      `${escapeHtml(problem.text)} Fix the cause and save again, so every part of the factory uses the same model.`,
    );
  }
  return problem.warning === undefined
    ? callout("err", "Not changed", escapeHtml(problem.text))
    : callout(
        "err",
        "Not changed: Hermes warned",
        `${escapeHtml(problem.text)} Check the name, or tick Use it anyway and save again.`,
      );
}

function providerName(catalog: ModelCatalog, slug: string): string {
  return catalog.providers.find((row) => row.slug === slug)?.name ?? slug;
}

function inUse(catalog: ModelCatalog): string {
  if (catalog.provider === "" || catalog.model === "") {
    return callout(
      "err",
      "No model",
      "The chat cannot answer until a model is set. Pick a provider, sign in, and choose a model.",
    );
  }
  const mixed = Object.values(catalog.profiles).some(
    (profile) => profile.provider !== catalog.provider || profile.model !== catalog.model,
  );
  return `<div class="row in-use"><div class="main"><span class="subline">In use</span><strong>${escapeHtml(catalog.model)}</strong> <span class="muted">from ${escapeHtml(providerName(catalog, catalog.provider))}</span>${
    mixed
      ? '<span class="subline">Parts of the factory are not all on this model. Saving a model below puts every part on it.</span>'
      : ""
  }</div><div class="aside">${statusText("done", "Set")}</div></div>`;
}

function providerSection(catalog: ModelCatalog, provider: ProviderRow | undefined): string {
  const rows = [...catalog.providers].sort(
    (a, b) => Number(b.authenticated) - Number(a.authenticated) || a.name.localeCompare(b.name),
  );
  const options = rows.map(
    (row) => [row.slug, `${row.name}${row.authenticated ? " (signed in)" : ""}`] as const,
  );
  const signedIn =
    provider === undefined || provider.slug === "custom"
      ? undefined
      : provider.authenticated
        ? statusText("done", "Signed in")
        : statusText("off", "Not signed in");
  return section({
    title: "1. Provider",
    right: signedIn,
    body: `<form class="form step" method="get" action="${PLANNING_PATH}">${field(
      "provider",
      "Provider",
      selectControl("provider", options, provider?.slug ?? ""),
    )}<div><button type="submit">Show this provider</button></div></form>`,
  });
}

/** How this provider signs in. */
function signInSection(
  catalog: ModelCatalog,
  provider: ProviderRow,
  login: DeviceLogin | undefined,
): string {
  return section({
    title: "2. Sign in",
    body: `<div class="step">${
      provider.slug === "custom"
        ? '<p class="muted">A custom endpoint needs no sign-in. Give its URL below.</p>'
        : signInHtml(catalog, provider, login)
    }</div>`,
  });
}

function modelSection(
  catalog: ModelCatalog,
  provider: ProviderRow,
  warned: Warned | undefined,
): string {
  const custom = provider.slug === "custom";
  const current = warned?.model ?? (catalog.provider === provider.slug ? catalog.model : "");
  const endpoint = custom
    ? `${input("base_url", "Endpoint URL", {
        type: "url",
        placeholder: "http://localhost:8080/v1",
        value: warned?.baseUrl ?? "",
        hint:
          warned !== undefined && warned.baseUrl === undefined
            ? "An OpenAI-compatible API. The URL you sent held a user name or password, so it is not shown again. Enter it again."
            : "An OpenAI-compatible API.",
      })}${input("key", "API key (optional)", {
        id: "custom-key",
        type: "password",
        autocomplete: "off",
        required: false,
        hint: `Stored on this host and never shown again.${warned === undefined ? "" : " Enter it again if the endpoint needs one."}`,
      })}`
    : "";
  // A provider Hermes lists models for gets the same dropdown as the Models tab; one without
  // a list, such as a custom endpoint, takes the name as typed.
  const modelField =
    provider.models.length === 0
      ? field(
          "model",
          "Model",
          `<input type="text" id="model" name="model" required value="${escapeHtml(current)}" autocomplete="off" aria-describedby="model-hint">`,
          { hint: "As the provider spells it." },
        )
      : field(
          "model",
          "Model",
          modelSelect(
            "model",
            provider.models,
            current,
            ' id="model" aria-describedby="model-hint"',
          ),
          { hint: "The models Hermes lists for this provider." },
        );
  return section({
    title: "3. Model",
    body: `<form class="form step" method="post" action="${PLANNING_PATH}/set" autocomplete="off"><input type="hidden" name="provider" value="${escapeHtml(provider.slug)}">${endpoint}${modelField}${warned === undefined ? "" : checkbox("force", "Use it anyway", { value: "on" })}<div><button type="submit" class="primary">Use this model</button></div></form>`,
  });
}

function signInHtml(
  catalog: ModelCatalog,
  provider: ProviderRow,
  login: DeviceLogin | undefined,
): string {
  const hidden = `<input type="hidden" name="provider" value="${escapeHtml(provider.slug)}">`;
  const oauth = catalog.oauth.find((row) => row.id === provider.slug);
  if (oauth?.flow === "device_code") {
    const mine = login?.provider === provider.slug ? login : undefined;
    if (mine?.status === "waiting" && mine.url !== undefined && mine.code !== undefined) {
      // Only a web address becomes a link; anything else is shown as text.
      const link = /^https?:\/\//i.test(mine.url)
        ? externalLink(mine.url, mine.url)
        : `<code>${escapeHtml(mine.url)}</code>`;
      return callout(
        "warn",
        "Waiting for sign-in",
        `Open ${link} and enter this code. This page updates when you are signed in.<br><span class="code-big">${escapeHtml(mine.code)}</span>`,
      );
    }
    const outcome =
      mine?.status === "signed-in"
        ? callout("info", "Signed in", escapeHtml(mine.error ?? "Pick a model below."))
        : mine?.status === "failed"
          ? callout("err", "Sign-in failed", escapeHtml(mine.error ?? "Try again."))
          : "";
    return `${outcome}<form method="post" action="${PLANNING_PATH}/login">${hidden}<button type="submit">${provider.authenticated ? "Sign in again" : "Sign in"}</button></form>`;
  }
  if (provider.auth_type === "api_key" && provider.key_env !== "") {
    const setupToken =
      provider.slug === "anthropic" ? " A <code>claude setup-token</code> token also works." : "";
    return `<form class="form" method="post" action="${PLANNING_PATH}/key" autocomplete="off">${hidden}${input(
      "key",
      "API key",
      {
        type: "password",
        autocomplete: "off",
        hint: `Stored on this host as <code>${escapeHtml(provider.key_env)}</code>.${setupToken}`,
      },
    )}<div><button type="submit">${provider.authenticated ? "Replace the key" : "Save the key"}</button></div></form>`;
  }
  // An external OAuth provider names its own command; anything else, such as AWS or Vertex
  // credentials, goes through Hermes's own picker.
  const command = oauth?.cli_command || "hermes model";
  return `<p>${provider.authenticated ? "Signed in. To sign in again, run this on the Hermes host" : "This provider signs in on the Hermes host. Run this"}, then reload the page:</p><pre class="block">HERMES_HOME=~/.hephaestus/hermes ${escapeHtml(command)}</pre>`;
}

/** What to tell the owner: a refusal says what to fix; anything else is logged, since it may carry details. */
function messageOf(error: unknown): string {
  if (error instanceof ModelError) return error.message;
  console.error("A model page action failed", error);
  return "Hephaestus could not change the model. The service log has the error.";
}
