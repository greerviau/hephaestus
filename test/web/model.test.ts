import { afterEach, describe, expect, it } from "vitest";
import {
  ModelError,
  ModelPartial,
  ModelWarning,
  type DeviceLogin,
  type ModelCatalog,
} from "../../src/hermes/factory-model.js";
import { RestartError } from "../../src/messaging.js";
import type { FactoryPages } from "../../src/web/factory.js";
import { startDashboard, type Dashboard } from "./dashboard.js";

let dashboard: Dashboard | undefined;

afterEach(async () => {
  await dashboard?.close();
  dashboard = undefined;
});

function catalog(overrides: Partial<ModelCatalog> = {}): ModelCatalog {
  return {
    provider: "anthropic",
    model: "claude-sonnet-5",
    providers: [
      {
        slug: "anthropic",
        name: "Anthropic",
        auth_type: "api_key",
        key_env: "ANTHROPIC_API_KEY",
        authenticated: true,
        models: ["claude-sonnet-5", "claude-opus-5-5"],
      },
      {
        slug: "deepseek",
        name: "DeepSeek",
        auth_type: "api_key",
        key_env: "DEEPSEEK_API_KEY",
        authenticated: false,
        models: [],
      },
      {
        slug: "openai-codex",
        name: "ChatGPT or Codex Subscription",
        auth_type: "oauth_external",
        key_env: "",
        authenticated: false,
        models: [],
      },
      {
        slug: "bedrock",
        name: "AWS Bedrock",
        auth_type: "aws_sdk",
        key_env: "",
        authenticated: false,
        models: [],
      },
      {
        slug: "custom",
        name: "custom",
        auth_type: "api_key",
        key_env: "",
        authenticated: false,
        models: [],
      },
    ],
    oauth: [
      {
        id: "openai-codex",
        name: "OpenAI Codex",
        flow: "device_code",
        cli_command: "hermes auth add openai-codex",
      },
      {
        id: "qwen-oauth",
        name: "Qwen",
        flow: "external",
        cli_command: "hermes auth add qwen-oauth",
      },
    ],
    profiles: {
      communicator: { provider: "anthropic", model: "claude-sonnet-5" },
      lead: { provider: "anthropic", model: "claude-sonnet-5" },
      improver: { provider: "anthropic", model: "claude-sonnet-5" },
    },
    ...overrides,
  };
}

interface FakeModel extends NonNullable<FactoryPages["model"]> {
  keys: [string, string][];
  choices: unknown[];
  logins: string[];
}

function fakeModel(
  options: {
    ready?: boolean;
    catalog?: ModelCatalog;
    refuse?: string;
    warn?: string;
    restartFails?: boolean;
    partial?: string;
    login?: DeviceLogin;
  } = {},
): FakeModel {
  const keys: [string, string][] = [];
  const choices: unknown[] = [];
  const logins: string[] = [];
  let login = options.login;
  return {
    keys,
    choices,
    logins,
    ready: () => options.ready ?? true,
    catalog: () => Promise.resolve(options.catalog ?? catalog()),
    addKey: (provider, key) => {
      if (options.refuse !== undefined) return Promise.reject(new ModelError(options.refuse));
      keys.push([provider, key]);
      return Promise.resolve();
    },
    setModel: (choice) => {
      if (options.refuse !== undefined) return Promise.reject(new ModelError(options.refuse));
      if (options.partial !== undefined) return Promise.reject(new ModelPartial(options.partial));
      if (options.warn !== undefined && choice.force !== true) {
        return Promise.reject(new ModelWarning(options.warn));
      }
      choices.push(choice);
      if (options.restartFails === true) {
        return Promise.reject(
          new RestartError("The settings were saved, but the messaging gateway did not restart."),
        );
      }
      return Promise.resolve();
    },
    startDeviceLogin: (provider) => {
      logins.push(provider);
      login = {
        provider,
        url: "https://auth.example/device",
        code: "ABCD-1234",
        status: "waiting",
      };
      return Promise.resolve(login);
    },
    deviceLogin: () => login,
  };
}

describe("Planning model page", () => {
  it("shows the current provider and model, and never names the factory's roles", async () => {
    dashboard = await startDashboard({ model: fakeModel() });

    const { status, html } = await dashboard.get("/config/models/planning");

    expect(status).toBe(200);
    expect(html).toContain("Anthropic");
    expect(html).toContain("claude-sonnet-5");
    expect(html).toContain('<option value="deepseek"');
    expect(html).not.toMatch(/communicator|improver|\blead\b/i);
    expect(html).toContain("Planning and chat model</h1>");
    expect(html).toContain('<a href="/config/models">Models</a>');
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it("links to Config when the factory Hermes is not set up", async () => {
    dashboard = await startDashboard({ model: fakeModel({ ready: false }) });

    expect((await dashboard.get("/config/models/planning")).html).toContain(
      '<a href="/config/versions">Config</a>',
    );
  });

  it("asks to deploy first when the factory Hermes is not set up", async () => {
    dashboard = await startDashboard({ model: fakeModel({ ready: false }) });

    const { html } = await dashboard.get("/config/models/planning");

    expect(html).toContain("Deploy a config version");
    expect(html).not.toContain('action="/config/models/planning/set"');
  });

  it("offers a key field for a provider that takes an API key, and saves the key", async () => {
    const model = fakeModel();
    dashboard = await startDashboard({ model });

    const page = (await dashboard.get("/config/models/planning?provider=deepseek")).html;
    expect(page).toContain('action="/config/models/planning/key"');
    expect(page).toContain('type="password"');
    expect(page).toContain("DEEPSEEK_API_KEY");

    const saved = await dashboard.post("/config/models/planning/key", {
      provider: "deepseek",
      key: "sk-test",
    });
    expect(saved.headers.get("location")).toBe(
      "/config/models/planning?provider=deepseek&notice=key",
    );
    expect(model.keys).toEqual([["deepseek", "sk-test"]]);
  });

  it("starts a device-code sign-in and shows its link and code while it waits", async () => {
    const model = fakeModel();
    dashboard = await startDashboard({ model });

    expect((await dashboard.get("/config/models/planning?provider=openai-codex")).html).toContain(
      'action="/config/models/planning/login"',
    );
    const started = await dashboard.post("/config/models/planning/login", {
      provider: "openai-codex",
    });
    expect(started.headers.get("location")).toBe("/config/models/planning?provider=openai-codex");
    expect(model.logins).toEqual(["openai-codex"]);

    const page = (await dashboard.get("/config/models/planning?provider=openai-codex")).html;
    expect(page).toContain("https://auth.example/device");
    expect(page).toContain("ABCD-1234");
    expect(page).toContain('http-equiv="refresh"');
  });

  it("says which host command signs in a provider the dashboard cannot", async () => {
    dashboard = await startDashboard({ model: fakeModel() });

    const page = (await dashboard.get("/config/models/planning?provider=bedrock")).html;

    expect(page).toContain("HERMES_HOME=~/.hephaestus/hermes hermes model");
    expect(page).not.toContain('action="/config/models/planning/key"');
  });

  it("saves a model for the chosen provider", async () => {
    const model = fakeModel();
    dashboard = await startDashboard({ model });

    const page = (await dashboard.get("/config/models/planning?provider=anthropic")).html;
    expect(page).toContain('<option value="claude-opus-5-5">');

    const saved = await dashboard.post("/config/models/planning/set", {
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
    expect(saved.headers.get("location")).toBe(
      "/config/models/planning?provider=anthropic&notice=saved",
    );
    expect(model.choices).toEqual([{ provider: "anthropic", model: "claude-opus-5-5" }]);
  });

  it("picks the model from the same dropdown as the Models tab, and saves the choice", async () => {
    const model = fakeModel();
    dashboard = await startDashboard({ model });

    const page = (await dashboard.get("/config/models/planning?provider=anthropic")).html;
    const control = /<select [^>]*name="model"[^>]*>(.*?)<\/select>/.exec(page);
    expect(control?.[0]).toContain('class="model"');
    expect([...(control?.[1] ?? "").matchAll(/<option value="([^"]*)"/g)].map((m) => m[1])).toEqual(
      ["claude-sonnet-5", "claude-opus-5-5"],
    );
    expect(control?.[1]).toContain('<option value="claude-sonnet-5" selected>');
    expect(page).not.toContain("<datalist");
    expect(page).not.toContain('list="models"');

    await dashboard.post("/config/models/planning/set", {
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
    expect(model.choices).toEqual([{ provider: "anthropic", model: "claude-opus-5-5" }]);
  });

  it("keeps a model field for a provider with no model list", async () => {
    dashboard = await startDashboard({ model: fakeModel() });

    const page = (await dashboard.get("/config/models/planning?provider=deepseek")).html;

    expect(page).toContain('<input type="text" id="model" name="model"');
    expect(page).not.toMatch(/<select [^>]*name="model"/);
  });

  it("takes a custom endpoint's URL and key with the model", async () => {
    const model = fakeModel();
    dashboard = await startDashboard({ model });

    expect((await dashboard.get("/config/models/planning?provider=custom")).html).toContain(
      'name="base_url"',
    );
    await dashboard.post("/config/models/planning/set", {
      provider: "custom",
      model: "llama-3",
      base_url: "http://localhost:8080/v1",
      key: "local",
    });

    expect(model.choices).toEqual([
      { provider: "custom", model: "llama-3", baseUrl: "http://localhost:8080/v1", key: "local" },
    ]);
  });

  it("shows Hermes's refusal and keeps the owner on the provider", async () => {
    dashboard = await startDashboard({
      model: fakeModel({ refuse: "Hermes refused the model: unknown model nope" }),
    });

    const response = await dashboard.post("/config/models/planning/set", {
      provider: "anthropic",
      model: "nope",
    });

    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("Hermes refused the model: unknown model nope");
    expect(html).toContain('<option value="anthropic" selected');
  });

  it("stops on Hermes's warning, keeps the model typed, and saves it when the owner insists", async () => {
    const model = fakeModel({
      warn: "`clade-opus` was not found in Anthropic's /v1/models listing.",
    });
    dashboard = await startDashboard({ model });

    const warned = await dashboard.post("/config/models/planning/set", {
      provider: "anthropic",
      model: "clade-opus",
    });
    expect(warned.status).toBe(400);
    const html = await warned.text();
    expect(html).toContain("Hermes warned");
    expect(html).toContain('value="clade-opus"');
    expect(html).toContain('name="force"');
    expect(model.choices).toEqual([]);

    const forced = await dashboard.post("/config/models/planning/set", {
      provider: "anthropic",
      model: "clade-opus",
      force: "on",
    });
    expect(forced.headers.get("location")).toBe(
      "/config/models/planning?provider=anthropic&notice=saved",
    );
    expect(model.choices).toEqual([{ provider: "anthropic", model: "clade-opus", force: true }]);
  });

  it("never shows the user name and password of an endpoint URL again", async () => {
    const url = "https://bob:s3cr%40t@llm.example/v1";
    const model = fakeModel({
      warn: "Could not reach https://bob:s3cr%40t@llm.example/v1/models (key sk-local-1, password s3cr@t).",
    });
    dashboard = await startDashboard({ model });

    const warned = await dashboard.post("/config/models/planning/set", {
      provider: "custom",
      model: "llama-3",
      base_url: url,
      key: "sk-local-1",
    });
    const html = await warned.text();

    expect(warned.status).toBe(400);
    expect(html).toContain("Hermes warned");
    expect(html).toContain('value="llama-3"');
    for (const secret of ["s3cr", "bob", "sk-local-1"]) expect(html).not.toContain(secret);
    expect(html).not.toContain('value="https://');
    expect(html).toContain("Could not reach https://[hidden]@llm.example/v1/models");
    expect(html).toContain("The URL you sent held a user name or password, so it is not shown");
    expect(model.choices).toEqual([]);
  });

  it("keeps an endpoint URL without a user name or password when Hermes warns", async () => {
    dashboard = await startDashboard({ model: fakeModel({ warn: "Not listed." }) });

    const warned = await dashboard.post("/config/models/planning/set", {
      provider: "custom",
      model: "llama-3",
      base_url: "http://localhost:8080/v1",
    });

    expect(await warned.text()).toContain('value="http://localhost:8080/v1"');
  });

  it("hides an endpoint URL's password in Hermes's refusal too", async () => {
    dashboard = await startDashboard({
      model: fakeModel({
        refuse: "Hermes refused the model: 401 from https://bob:hunter22@x.example",
      }),
    });

    const refused = await dashboard.post("/config/models/planning/set", {
      provider: "custom",
      model: "llama-3",
      base_url: "https://bob:hunter22@x.example/v1",
    });
    const html = await refused.text();

    expect(refused.status).toBe(400);
    expect(html).toContain("Hermes refused the model: 401 from");
    expect(html).not.toContain("hunter22");
  });

  it("warns when parts of the factory use another model", async () => {
    dashboard = await startDashboard({
      model: fakeModel({
        catalog: catalog({
          profiles: {
            communicator: { provider: "anthropic", model: "claude-sonnet-5" },
            lead: { provider: "deepseek", model: "deepseek-chat" },
            improver: { provider: "anthropic", model: "claude-sonnet-5" },
          },
        }),
      }),
    });

    expect((await dashboard.get("/config/models/planning")).html).toContain(
      "not all on this model",
    );
  });

  it("says a save took when only the gateway restart failed", async () => {
    dashboard = await startDashboard({ model: fakeModel({ restartFails: true }) });

    const response = await dashboard.post("/config/models/planning/set", {
      provider: "anthropic",
      model: "claude-opus-5-5",
    });

    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("Saved, but the chat did not restart");
    expect(html).toContain('<a href="/chat">Chat</a>');
    expect(html).not.toContain("Not changed");
  });

  it("refuses a change with no provider", async () => {
    const model = fakeModel();
    dashboard = await startDashboard({ model });

    const response = await dashboard.post("/config/models/planning/set", {
      model: "claude-opus-5-5",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Pick a provider first.");
    expect(model.choices).toEqual([]);
  });

  it("ignores notice names that are not its own", async () => {
    dashboard = await startDashboard({ model: fakeModel() });

    for (const notice of ["constructor", "__proto__", "toString"]) {
      expect((await dashboard.get(`/config/models/planning?notice=${notice}`)).status).toBe(200);
    }
  });

  it("escapes everything Hermes reports, and links only a web address", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const base = catalog();
    dashboard = await startDashboard({
      model: fakeModel({
        catalog: {
          ...base,
          provider: "evil",
          model: hostile,
          providers: [
            {
              slug: "evil",
              name: hostile,
              auth_type: "api_key",
              key_env: hostile,
              authenticated: false,
              models: [hostile],
            },
          ],
          oauth: [{ id: "evil", name: hostile, flow: "device_code", cli_command: hostile }],
        },
        login: {
          provider: "evil",
          url: "javascript:alert(1)",
          code: hostile,
          status: "waiting",
        },
      }),
    });

    const html = (await dashboard.get("/config/models/planning?provider=evil")).html;

    expect(html).not.toContain(hostile);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain('href="javascript:');
  });

  it("says a save Hermes refused partway was partly saved", async () => {
    dashboard = await startDashboard({
      model: fakeModel({
        partial: "Hermes refused the model while saving it (saved for the root so far): 409",
      }),
    });

    const response = await dashboard.post("/config/models/planning/set", {
      provider: "custom",
      model: "llama",
    });

    const html = await response.text();
    expect(html).toContain("Partly saved");
    expect(html).not.toContain("Not changed");
  });

  it("does not refresh an error page while a sign-in waits", async () => {
    dashboard = await startDashboard({
      model: fakeModel({
        refuse: "Hermes refused the model: no",
        login: { provider: "openai-codex", url: "https://a/", code: "C", status: "waiting" },
      }),
    });

    expect((await dashboard.get("/config/models/planning?provider=openai-codex")).html).toContain(
      'http-equiv="refresh"',
    );
    const response = await dashboard.post("/config/models/planning/set", {
      provider: "openai-codex",
      model: "x",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('http-equiv="refresh"');
  });

  it("shows a restart failure after a sign-in", async () => {
    dashboard = await startDashboard({
      model: fakeModel({
        login: {
          provider: "openai-codex",
          status: "signed-in",
          error: "Signed in, but the factory's chat did not restart.",
        },
      }),
    });

    expect((await dashboard.get("/config/models/planning?provider=openai-codex")).html).toContain(
      "Signed in, but the factory&#39;s chat did not restart.",
    );
  });

  it("escapes a key variable, a host command, and a sign-in address that is not a web link", async () => {
    const hostile = "<b>x</b>";
    const base = catalog();
    const providers = [
      {
        slug: "keyed",
        name: "Keyed",
        auth_type: "api_key",
        key_env: hostile,
        authenticated: false,
        models: [],
      },
      {
        slug: "outside",
        name: "Outside",
        auth_type: "oauth_external",
        key_env: "",
        authenticated: false,
        models: [],
      },
      {
        slug: "device",
        name: "Device",
        auth_type: "oauth_external",
        key_env: "",
        authenticated: false,
        models: [],
      },
    ];
    const oauth = [
      { id: "outside", name: "Outside", flow: "external", cli_command: hostile },
      { id: "device", name: "Device", flow: "device_code", cli_command: "" },
    ];
    dashboard = await startDashboard({
      model: fakeModel({
        catalog: { ...base, providers, oauth },
        login: { provider: "device", url: `javascript:${hostile}`, code: "C", status: "waiting" },
      }),
    });

    for (const slug of ["keyed", "outside", "device"]) {
      const html = (await dashboard.get(`/config/models/planning?provider=${slug}`)).html;
      expect(html).not.toContain(hostile);
    }
  });
});

const SUMMARY = "/config/models/planning/summary";

describe("Models tab: planning and chat", () => {
  it("opens without waiting for Hermes and loads the model in use into a placeholder", async () => {
    const slow = fakeModel();
    let reads = 0;
    slow.catalog = () => {
      reads += 1;
      return new Promise<ModelCatalog>(() => undefined);
    };
    dashboard = await startDashboard({ model: slow });

    const { status, html } = await dashboard.get("/config/models");

    expect(status).toBe(200);
    expect(reads).toBe(0);
    expect(html).toContain(`data-lazy-url="${SUMMARY}"`);
    expect(html).toContain("Loading");
    expect(html).toContain('<script src="/assets/lazy.js" defer></script>');
    expect(html).toContain('name="claude.model"');
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it("serves the script that fills the placeholder", async () => {
    dashboard = await startDashboard({ model: fakeModel() });

    const response = await fetch(`${dashboard.base}/assets/lazy.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
  });

  it("shows the model in use, that its provider is signed in, and a link to change it", async () => {
    dashboard = await startDashboard({ model: fakeModel() });

    const { status, html } = await dashboard.get(SUMMARY);

    expect(status).toBe(200);
    expect(html).toContain("<strong>claude-sonnet-5</strong>");
    expect(html).toContain("Anthropic");
    expect(html).toContain("Signed in");
    expect(html).toContain('<a class="btn" href="/config/models/planning">Change</a>');
  });

  it("says the provider is not signed in", async () => {
    dashboard = await startDashboard({
      model: fakeModel({ catalog: catalog({ provider: "deepseek", model: "deepseek-chat" }) }),
    });

    const { html } = await dashboard.get(SUMMARY);

    expect(html).toContain("<strong>deepseek-chat</strong>");
    expect(html).toContain("Not signed in");
  });

  it("says Not set with a Set up button when no model is set", async () => {
    dashboard = await startDashboard({
      model: fakeModel({ catalog: catalog({ provider: "", model: "" }) }),
    });

    const { html } = await dashboard.get(SUMMARY);

    expect(html).toContain("Not set");
    expect(html).toContain('<a class="btn primary" href="/config/models/planning">Set up</a>');
  });

  it("escapes what Hermes reports", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    dashboard = await startDashboard({
      model: fakeModel({
        catalog: catalog({
          provider: "evil",
          model: hostile,
          providers: [
            {
              slug: "evil",
              name: hostile,
              auth_type: "api_key",
              key_env: "",
              authenticated: true,
              models: [],
            },
          ],
        }),
      }),
    });

    expect((await dashboard.get(SUMMARY)).html).not.toContain(hostile);
  });

  it("still shows the coding models when Hermes does not answer, is not ready, or is absent", async () => {
    const down = fakeModel();
    down.catalog = () => Promise.reject(new Error("spawn failed: /secret/path"));
    dashboard = await startDashboard({ model: down });
    const failed = (await dashboard.get(SUMMARY)).html;
    expect(failed).toContain("Hermes did not answer");
    expect(failed).not.toContain("/secret/path");
    expect((await dashboard.get("/config/models")).html).toContain('name="claude.model"');
    await dashboard.close();

    dashboard = await startDashboard({ model: fakeModel({ ready: false }) });
    expect((await dashboard.get("/config/models")).html).toContain("Not ready yet");
    await dashboard.close();

    dashboard = await startDashboard();
    const absent = (await dashboard.get("/config/models")).html;
    expect(absent).toContain("This install has no factory Hermes");
    expect(absent).toContain('name="claude.model"');
  });

  it("reads Hermes once for repeated visits, and again on an explicit refresh", async () => {
    const counted = fakeModel();
    let reads = 0;
    counted.catalog = () => {
      reads += 1;
      return Promise.resolve(catalog());
    };
    dashboard = await startDashboard({ model: counted });

    await dashboard.get(SUMMARY);
    await dashboard.get(SUMMARY);
    expect(reads).toBe(1);

    await dashboard.get(`${SUMMARY}?refresh=1`);
    expect(reads).toBe(2);
  });

  it("does not keep an answer that said Hermes was down", async () => {
    const flaky = fakeModel();
    let reads = 0;
    flaky.catalog = () => {
      reads += 1;
      return reads === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(catalog());
    };
    dashboard = await startDashboard({ model: flaky });

    expect((await dashboard.get(SUMMARY)).html).toContain("Hermes did not answer");
    expect((await dashboard.get(SUMMARY)).html).toContain("<strong>claude-sonnet-5</strong>");
  });

  it("reads Hermes again after the model or a key is saved", async () => {
    const counted = fakeModel();
    let reads = 0;
    counted.catalog = () => {
      reads += 1;
      return Promise.resolve(catalog());
    };
    dashboard = await startDashboard({ model: counted });
    await dashboard.get(SUMMARY);
    expect(reads).toBe(1);

    await dashboard.post("/config/models/planning/set", {
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
    await dashboard.get(SUMMARY);
    expect(reads).toBe(2);

    await dashboard.post("/config/models/planning/key", { provider: "deepseek", key: "k" });
    await dashboard.get(SUMMARY);
    expect(reads).toBe(3);
  });

  it("has the planning page drop the browser's copy of the summary", async () => {
    dashboard = await startDashboard({ model: fakeModel() });

    const { html } = await dashboard.get("/config/models/planning");

    expect(html).toContain(`data-lazy-forget="${SUMMARY}"`);
  });
});
