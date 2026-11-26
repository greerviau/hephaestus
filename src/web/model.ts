import {
  ModelError,
  ModelPartial,
  ModelWarning,
  type DeviceLogin,
  type ModelCatalog,
  type ProviderRow,
} from "../hermes/factory-model.js";
import { RestartError } from "../messaging.js";
import type { FactoryPages } from "./factory.js";
import { banner, card, empty, escapeHtml, layout, pageHead, pill } from "./html.js";
import { readBody, redirect, sendHtml, type Route, type RouteContext } from "./http.js";

const MAX_FORM_BYTES = 16 * 1024;
const SECTION = "/model";

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

/** Why a change did not happen; a warning keeps what the owner typed so they can save it anyway. */
type Problem = {
  text: string;
  warning?: { model: string; baseUrl: string };
  /** The change was saved but the gateway did not restart. */
  saved?: boolean;
  /** Hermes refused partway, after some of the factory was written. */
  partial?: boolean;
};

/** The Model page: give the factory Hermes a provider and model, with any provider Hermes supports. */
export function modelRoutes(factory: FactoryPages): Route[] {
  const model = factory.model;
  return [
    {
      method: "GET",
      path: /^\/model$/,
      handle: async ({ response, url }) => {
        const notice = url.searchParams.get("notice") ?? "";
        const chosen = url.searchParams.get("provider") ?? "";
        sendHtml(response, 200, await page(chosen, notice, undefined));
      },
    },
    {
      method: "POST",
      path: /^\/model\/(key|login|set)$/,
      handle: (context) => act(context),
    },
  ];

  async function act({ request, response, params }: RouteContext): Promise<void> {
    const body = await readBody(request, MAX_FORM_BYTES);
    if (model === undefined || body === undefined) {
      redirect(response, SECTION);
      return;
    }
    const form = new URLSearchParams(body);
    const provider = form.get("provider") ?? "";
    const back = `${SECTION}?provider=${encodeURIComponent(provider)}`;
    try {
      if (provider === "") throw new ModelError("Pick a provider first.");
      if (params[0] === "key") {
        await model.addKey(provider, form.get("key") ?? "");
        redirect(response, `${back}&notice=key`);
      } else if (params[0] === "login") {
        await model.startDeviceLogin(provider);
        redirect(response, back);
      } else {
        const baseUrl = form.get("base_url")?.trim() ?? "";
        const key = form.get("key")?.trim() ?? "";
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
          const problem = { text: error.message, warning: { model: chosen, baseUrl } };
          sendHtml(response, 400, await page(provider, "", problem));
          return;
        }
        redirect(response, `${back}&notice=saved`);
      }
    } catch (error) {
      if (error instanceof RestartError) {
        sendHtml(response, 400, await page(provider, "", { text: error.message, saved: true }));
        return;
      }
      sendHtml(
        response,
        400,
        await page(provider, "", {
          text: messageOf(error),
          ...(error instanceof ModelPartial ? { partial: true } : {}),
        }),
      );
    }
  }

  async function page(
    chosen: string,
    notice: string,
    problem: Problem | undefined,
  ): Promise<string> {
    const head = pageHead({
      title: "Model",
      lede: "The provider and model the factory's Hermes uses, for the chat you ask for work in and for its own background work. Any provider Hermes supports works here.",
    });
    if (model === undefined) {
      return layout(
        "Model",
        `${head}${empty("This install has no factory Hermes, so there is no model to set.")}`,
        { section: SECTION },
      );
    }
    if (!model.ready()) {
      return layout(
        "Model",
        `${head}${banner("info", "Not ready yet", "Deploy a config version on Settings first; it sets up the factory's Hermes.")}`,
        { section: SECTION },
      );
    }
    let catalog: ModelCatalog;
    try {
      catalog = await model.catalog();
    } catch (error) {
      return layout("Model", `${head}${banner("err", "Hermes did not answer", messageOf(error))}`, {
        section: SECTION,
      });
    }
    const login = model.deviceLogin();
    const provider =
      catalog.providers.find((row) => row.slug === chosen) ??
      catalog.providers.find((row) => row.slug === catalog.provider) ??
      catalog.providers[0];
    const shown = Object.hasOwn(NOTICES, notice) ? NOTICES[notice] : undefined;
    const waiting = login?.status === "waiting" && login.provider === provider?.slug;
    const body = `${head}${shown === undefined ? "" : banner("info", shown.title, shown.text)}${
      problem === undefined
        ? ""
        : problem.saved === true
          ? banner(
              "err",
              "Saved, but the chat did not restart",
              `${problem.text} Restart it on the Messaging page.`,
            )
          : banner(
              "err",
              problem.partial === true
                ? "Partly saved"
                : problem.warning === undefined
                  ? "Not changed"
                  : "Not changed: Hermes warned",
              problem.partial === true
                ? `${problem.text} Fix the cause and save again, so every part of the factory uses the same model.`
                : problem.warning === undefined
                  ? problem.text
                  : `${problem.text} Check the name, or tick Use it anyway and save again.`,
            )
    }<div class="grid">${currentCard(catalog)}${pickerCard(catalog, provider?.slug ?? "")}${
      provider === undefined ? "" : providerCard(catalog, provider, login, problem?.warning)
    }</div>`;
    // An error page is rendered at the POST's address, which has no GET route to refresh to.
    const refresh = waiting && problem === undefined;
    return layout("Model", body, { section: SECTION, ...(refresh ? { refreshSeconds: 5 } : {}) });
  }
}

function providerName(catalog: ModelCatalog, slug: string): string {
  return catalog.providers.find((row) => row.slug === slug)?.name ?? slug;
}

function currentCard(catalog: ModelCatalog): string {
  if (catalog.provider === "" || catalog.model === "") {
    return card({
      title: "In use",
      span: 12,
      meta: pill("bad", "No model"),
      body: `<p class="lede">The factory's Hermes has no model, so the chat cannot answer. Pick a provider below, sign in, and choose a model.</p>`,
    });
  }
  const mixed = Object.values(catalog.profiles).some(
    (profile) => profile.provider !== catalog.provider || profile.model !== catalog.model,
  );
  return card({
    title: "In use",
    span: 12,
    meta: pill("run", "Set"),
    body: `<p class="lede"><strong>${escapeHtml(catalog.model)}</strong> from ${escapeHtml(providerName(catalog, catalog.provider))}.${
      mixed
        ? " Parts of the factory are not all on this model. Saving a model below puts every part on it."
        : ""
    }</p>`,
  });
}

function pickerCard(catalog: ModelCatalog, selected: string): string {
  const rows = [...catalog.providers].sort(
    (a, b) => Number(b.authenticated) - Number(a.authenticated) || a.name.localeCompare(b.name),
  );
  const options = rows
    .map(
      (row) =>
        `<option value="${escapeHtml(row.slug)}"${row.slug === selected ? " selected" : ""}>${escapeHtml(row.name)}${row.authenticated ? " (signed in)" : ""}</option>`,
    )
    .join("");
  return card({
    title: "Provider",
    span: 12,
    body: `<form method="get" action="/model" class="form-grid"><div class="field"><label for="provider">Provider</label><select id="provider" name="provider">${options}</select></div><div class="btn-row"><button type="submit" class="btn-secondary">Show</button></div></form>`,
  });
}

/** How this provider signs in, and the model form. */
function providerCard(
  catalog: ModelCatalog,
  provider: ProviderRow,
  login: DeviceLogin | undefined,
  warned: { model: string; baseUrl: string } | undefined,
): string {
  const custom = provider.slug === "custom";
  const signIn = custom ? "" : signInHtml(catalog, provider, login);
  const models = provider.models
    .map((name) => `<option value="${escapeHtml(name)}"></option>`)
    .join("");
  const current = warned?.model ?? (catalog.provider === provider.slug ? catalog.model : "");
  const endpoint = custom
    ? `<div class="field"><label for="base_url">Endpoint URL</label><input type="url" id="base_url" name="base_url" required placeholder="http://localhost:8080/v1" value="${escapeHtml(warned?.baseUrl ?? "")}"><span class="meta">An OpenAI-compatible API.</span></div><div class="field"><label for="custom-key">API key (optional)</label><input type="password" id="custom-key" name="key" autocomplete="off"><span class="meta">Kept in files only you can read on this host. It is never shown again.</span></div>`
    : "";
  const form = `<form method="post" action="/model/set" class="form-grid" autocomplete="off"><input type="hidden" name="provider" value="${escapeHtml(provider.slug)}">${endpoint}<div class="field"><label for="model">Model</label><input type="text" id="model" name="model" required value="${escapeHtml(current)}"${models === "" ? "" : ' list="models"'} autocomplete="off">${models === "" ? "" : `<datalist id="models">${models}</datalist>`}<span class="meta">${models === "" ? "Type the model's name as the provider spells it." : "Pick one Hermes lists, or type another."} Hermes checks it before saving.</span></div>${warned === undefined ? "" : `<div class="field"><label><input type="checkbox" name="force"> Use it anyway</label>${custom ? '<span class="meta">Enter the key again if the endpoint needs one.</span>' : ""}</div>`}<div class="btn-row"><button type="submit" class="btn-primary">Use this model</button></div></form>`;
  return card({
    title: provider.name,
    span: 12,
    meta: custom
      ? ""
      : pill(
          provider.authenticated ? "run" : "off",
          provider.authenticated ? "Signed in" : "Not signed in",
        ),
    body: `${signIn}${form}`,
  });
}

function signInHtml(
  catalog: ModelCatalog,
  provider: ProviderRow,
  login: DeviceLogin | undefined,
): string {
  const oauth = catalog.oauth.find((row) => row.id === provider.slug);
  if (oauth?.flow === "device_code") {
    const mine = login?.provider === provider.slug ? login : undefined;
    if (mine?.status === "waiting" && mine.url !== undefined && mine.code !== undefined) {
      // Only a web address becomes a link; anything else is shown as text.
      const link = /^https?:\/\//i.test(mine.url)
        ? `<a href="${escapeHtml(mine.url)}" rel="noreferrer" target="_blank">${escapeHtml(mine.url)}</a>`
        : `<code>${escapeHtml(mine.url)}</code>`;
      return `<p class="lede">Open ${link} and enter <code>${escapeHtml(mine.code)}</code>. This page updates when you are signed in.</p>`;
    }
    const outcome =
      mine?.status === "signed-in"
        ? banner("info", "Signed in", mine.error ?? "Pick a model below.")
        : mine?.status === "failed"
          ? banner("err", "Sign-in failed", mine.error ?? "Try again.")
          : "";
    return `${outcome}<form method="post" action="/model/login" class="btn-row"><input type="hidden" name="provider" value="${escapeHtml(provider.slug)}"><button type="submit" class="${provider.authenticated ? "btn-secondary" : "btn-primary"}">${provider.authenticated ? "Sign in again" : "Sign in"}</button></form>`;
  }
  if (provider.auth_type === "api_key" && provider.key_env !== "") {
    const setupToken =
      provider.slug === "anthropic"
        ? " A token that <code>claude setup-token</code> prints works too, and is saved as <code>ANTHROPIC_TOKEN</code>."
        : "";
    return `<form method="post" action="/model/key" class="form-grid" autocomplete="off"><input type="hidden" name="provider" value="${escapeHtml(provider.slug)}"><div class="field"><label for="key">API key</label><input type="password" id="key" name="key" required autocomplete="off"><span class="meta">Saved as <code>${escapeHtml(provider.key_env)}</code> in files only you can read on this host. It is never shown again.${setupToken}</span></div><div class="btn-row"><button type="submit" class="${provider.authenticated ? "btn-secondary" : "btn-primary"}">${provider.authenticated ? "Replace the key" : "Save the key"}</button></div></form>`;
  }
  // An external OAuth provider names its own command; anything else, such as AWS or Vertex
  // credentials, goes through Hermes's own picker.
  const command = oauth?.cli_command || "hermes model";
  return `<p class="lede">${provider.authenticated ? "Signed in. To sign in again" : "This provider signs in"} on the Hermes host: run <code>HERMES_HOME=~/.hephaestus/hermes ${escapeHtml(command)}</code>, then reload this page.</p>`;
}

/** What to tell the owner: a refusal says what to fix; anything else is logged, since it may carry details. */
function messageOf(error: unknown): string {
  if (error instanceof ModelError) return error.message;
  console.error("A model page action failed", error);
  return "Hephaestus could not change the model. The service log has the error.";
}
