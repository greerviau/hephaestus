import { afterEach, describe, expect, it } from "vitest";
import {
  ModelError,
  ModelWarning,
  type DeviceLogin,
  type ModelCatalog,
} from "../../src/hermes/factory-model.js";
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
        logged_in: false,
      },
      {
        id: "qwen-oauth",
        name: "Qwen",
        flow: "external",
        cli_command: "hermes auth add qwen-oauth",
        logged_in: false,
      },
    ],
    profiles: {
      planner: { provider: "anthropic", model: "claude-sonnet-5" },
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
      if (options.warn !== undefined && choice.force !== true) {
        return Promise.reject(new ModelWarning(options.warn));
      }
      choices.push(choice);
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

describe("Model page", () => {
  it("shows the current provider and model, and never names the factory's roles", async () => {
    dashboard = await startDashboard({ model: fakeModel() });

    const { status, html } = await dashboard.get("/model");

    expect(status).toBe(200);
    expect(html).toContain("Anthropic");
    expect(html).toContain("claude-sonnet-5");
    expect(html).toContain('<option value="deepseek"');
    expect(html).not.toMatch(/planner|improver|\blead\b/i);
  });

  it("asks to deploy first when the factory Hermes is not set up", async () => {
    dashboard = await startDashboard({ model: fakeModel({ ready: false }) });

    const { html } = await dashboard.get("/model");

    expect(html).toContain("Deploy a config version");
    expect(html).not.toContain('action="/model/set"');
  });

  it("offers a key field for a provider that takes an API key, and saves the key", async () => {
    const model = fakeModel();
    dashboard = await startDashboard({ model });

    const page = (await dashboard.get("/model?provider=deepseek")).html;
    expect(page).toContain('action="/model/key"');
    expect(page).toContain('type="password"');
    expect(page).toContain("DEEPSEEK_API_KEY");

    const saved = await dashboard.post("/model/key", { provider: "deepseek", key: "sk-test" });
    expect(saved.headers.get("location")).toBe("/model?provider=deepseek&notice=key");
    expect(model.keys).toEqual([["deepseek", "sk-test"]]);
  });

  it("starts a device-code sign-in and shows its link and code while it waits", async () => {
    const model = fakeModel();
    dashboard = await startDashboard({ model });

    expect((await dashboard.get("/model?provider=openai-codex")).html).toContain(
      'action="/model/login"',
    );
    const started = await dashboard.post("/model/login", { provider: "openai-codex" });
    expect(started.headers.get("location")).toBe("/model?provider=openai-codex");
    expect(model.logins).toEqual(["openai-codex"]);

    const page = (await dashboard.get("/model?provider=openai-codex")).html;
    expect(page).toContain("https://auth.example/device");
    expect(page).toContain("ABCD-1234");
    expect(page).toContain('http-equiv="refresh"');
  });

  it("says which host command signs in a provider the dashboard cannot", async () => {
    dashboard = await startDashboard({ model: fakeModel() });

    const page = (await dashboard.get("/model?provider=bedrock")).html;

    expect(page).toContain("HERMES_HOME=~/.hephaestus/hermes hermes model");
    expect(page).not.toContain('action="/model/key"');
  });

  it("saves a model for the chosen provider", async () => {
    const model = fakeModel();
    dashboard = await startDashboard({ model });

    const page = (await dashboard.get("/model?provider=anthropic")).html;
    expect(page).toContain('<option value="claude-opus-5-5">');

    const saved = await dashboard.post("/model/set", {
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
    expect(saved.headers.get("location")).toBe("/model?provider=anthropic&notice=saved");
    expect(model.choices).toEqual([{ provider: "anthropic", model: "claude-opus-5-5" }]);
  });

  it("takes a custom endpoint's URL and key with the model", async () => {
    const model = fakeModel();
    dashboard = await startDashboard({ model });

    expect((await dashboard.get("/model?provider=custom")).html).toContain('name="base_url"');
    await dashboard.post("/model/set", {
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

    const response = await dashboard.post("/model/set", { provider: "anthropic", model: "nope" });

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

    const warned = await dashboard.post("/model/set", {
      provider: "anthropic",
      model: "clade-opus",
    });
    expect(warned.status).toBe(400);
    const html = await warned.text();
    expect(html).toContain("Hermes warned");
    expect(html).toContain('value="clade-opus"');
    expect(html).toContain('name="force"');
    expect(model.choices).toEqual([]);

    const forced = await dashboard.post("/model/set", {
      provider: "anthropic",
      model: "clade-opus",
      force: "on",
    });
    expect(forced.headers.get("location")).toBe("/model?provider=anthropic&notice=saved");
    expect(model.choices).toEqual([{ provider: "anthropic", model: "clade-opus", force: true }]);
  });

  it("warns when parts of the factory use another model", async () => {
    dashboard = await startDashboard({
      model: fakeModel({
        catalog: catalog({
          profiles: {
            planner: { provider: "anthropic", model: "claude-sonnet-5" },
            lead: { provider: "deepseek", model: "deepseek-chat" },
            improver: { provider: "anthropic", model: "claude-sonnet-5" },
          },
        }),
      }),
    });

    expect((await dashboard.get("/model")).html).toContain("not all on this model");
  });
});
