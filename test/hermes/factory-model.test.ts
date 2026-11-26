import { describe, expect, it } from "vitest";
import {
  FactoryModel,
  ModelError,
  ModelWarning,
  type LoginProcess,
  type ModelCatalog,
} from "../../src/hermes/factory-model.js";

const CATALOG: ModelCatalog = {
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
      slug: "openai-codex",
      name: "ChatGPT or Codex Subscription",
      auth_type: "oauth_external",
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
  ],
  profiles: {
    planner: { provider: "anthropic", model: "claude-sonnet-5" },
    lead: { provider: "anthropic", model: "claude-sonnet-5" },
    improver: { provider: "anthropic", model: "claude-sonnet-5" },
  },
};

interface Call {
  args: string[];
  input?: string;
}

/** A login process whose output lines and exit the test controls. */
function fakeLogin(): {
  process: LoginProcess;
  line(text: string): void;
  exit(code: number): void;
} {
  const listeners: ((line: string) => void)[] = [];
  let finish: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });
  return {
    process: {
      onLine: (listener) => listeners.push(listener),
      done,
      stop: () => {
        finish(143);
      },
    },
    line: (text) => {
      for (const listener of listeners) listener(text);
    },
    exit: (code) => {
      finish(code);
    },
  };
}

function setup(output: (args: string[]) => string = () => "") {
  const calls: Call[] = [];
  const restarts: number[] = [];
  const logins: { provider: string; login: ReturnType<typeof fakeLogin> }[] = [];
  const model = new FactoryModel({
    ready: () => true,
    run: (args, options) => {
      calls.push({ args, ...(options?.input === undefined ? {} : { input: options.input }) });
      return Promise.resolve(output(args));
    },
    restartGateway: () => {
      restarts.push(1);
      return Promise.resolve();
    },
    startLogin: (provider) => {
      const login = fakeLogin();
      logins.push({ provider, login });
      return login.process;
    },
  });
  return { model, calls, restarts, logins };
}

describe("FactoryModel", () => {
  it("reads the catalog for the root and all three profiles, skipping lines Hermes prints first", async () => {
    const { model, calls } = setup(
      () => `Warning: install out of sync\n${JSON.stringify(CATALOG)}\n`,
    );

    const catalog = await model.catalog();

    expect(catalog.provider).toBe("anthropic");
    expect(catalog.providers.map((provider) => provider.slug)).toEqual([
      "anthropic",
      "openai-codex",
    ]);
    expect(calls).toEqual([
      { args: ["hephaestus", "catalog", "--profiles", "planner,lead,improver"] },
    ]);
  });

  it("refuses catalog output without JSON, so the page can say Hermes is out of date", async () => {
    const { model } = setup(() => "usage: hermes [-h]\n");

    await expect(model.catalog()).rejects.toThrow(ModelError);
  });

  it("passes an API key on stdin, never on the command line, and restarts the gateway", async () => {
    const { model, calls, restarts } = setup(() => '{"ok": true, "env": "DEEPSEEK_API_KEY"}\n');

    await model.addKey("deepseek", "  sk-secret  ");

    expect(calls).toEqual([
      {
        args: [
          "hephaestus",
          "add-key",
          "--provider",
          "deepseek",
          "--profiles",
          "planner,lead,improver",
        ],
        input: "sk-secret",
      },
    ]);
    expect(JSON.stringify(calls[0]?.args)).not.toContain("sk-secret");
    expect(restarts).toHaveLength(1);
  });

  it("refuses an empty key without running Hermes", async () => {
    const { model, calls } = setup();

    await expect(model.addKey("deepseek", "   ")).rejects.toThrow("Paste the key");
    expect(calls).toEqual([]);
  });

  it("sets the provider and model on the root and every profile, then restarts the gateway", async () => {
    const { model, calls, restarts } = setup(
      () => '{"ok": true, "provider": "deepseek", "model": "deepseek-chat"}\n',
    );

    await model.setModel({ provider: "deepseek", model: "deepseek-chat" });

    expect(calls).toEqual([
      {
        args: [
          "hephaestus",
          "set-model",
          "--provider",
          "deepseek",
          "--model",
          "deepseek-chat",
          "--profiles",
          "planner,lead,improver",
        ],
      },
    ]);
    expect(restarts).toHaveLength(1);
  });

  it("sends a custom endpoint's URL as an argument and its key on stdin", async () => {
    const { model, calls } = setup(() => '{"ok": true}\n');

    await model.setModel({
      provider: "custom",
      model: "llama-3",
      baseUrl: "http://localhost:8080/v1",
      key: "local-key",
    });

    expect(calls[0]).toEqual({
      args: [
        "hephaestus",
        "set-model",
        "--provider",
        "custom",
        "--model",
        "llama-3",
        "--profiles",
        "planner,lead,improver",
        "--base-url",
        "http://localhost:8080/v1",
        "--key-on-stdin",
      ],
      input: "local-key",
    });
  });

  it("turns Hermes's refusal into a message the owner can act on", async () => {
    const restarts: number[] = [];
    const refusing = new FactoryModel({
      ready: () => true,
      run: () =>
        Promise.reject(
          new Error(
            "hermes hephaestus set-model failed: Hermes refused the model: unknown model nope",
          ),
        ),
      restartGateway: () => {
        restarts.push(1);
        return Promise.resolve();
      },
      startLogin: () => fakeLogin().process,
    });

    await expect(refusing.setModel({ provider: "anthropic", model: "nope" })).rejects.toThrow(
      "Hermes refused the model: unknown model nope",
    );
    expect(restarts).toEqual([]);
  });

  it("reports Hermes's warning as a warning, and passes --force when the owner insists", async () => {
    const calls: string[][] = [];
    const warning = new FactoryModel({
      ready: () => true,
      run: (args) => {
        calls.push(args);
        return args.includes("--force")
          ? Promise.resolve('{"ok": true}\n')
          : Promise.reject(
              new Error("hermes hephaestus set-model failed: Hermes warned: `x` was not found."),
            );
      },
      restartGateway: () => Promise.resolve(),
      startLogin: () => fakeLogin().process,
    });

    await expect(warning.setModel({ provider: "anthropic", model: "x" })).rejects.toBeInstanceOf(
      ModelWarning,
    );
    await warning.setModel({ provider: "anthropic", model: "x", force: true });

    expect(calls[1]).toContain("--force");
  });

  it("shows a device login's link and code, then reports it signed in and restarts the gateway", async () => {
    const { model, logins, restarts } = setup();

    const started = model.startDeviceLogin("openai-codex");
    const login = logins[0]?.login;
    login?.line(
      '{"url": "https://auth.openai.com/codex/device", "code": "ABCD-1234", "expires_in": 900}',
    );
    const shown = await started;

    expect(logins[0]?.provider).toBe("openai-codex");
    expect(shown).toMatchObject({
      provider: "openai-codex",
      url: "https://auth.openai.com/codex/device",
      code: "ABCD-1234",
      status: "waiting",
    });

    login?.line('{"status": "approved", "error": ""}');
    login?.exit(0);
    await model.settled();

    expect(model.deviceLogin()).toMatchObject({ provider: "openai-codex", status: "signed-in" });
    expect(restarts).toHaveLength(1);
  });

  it("reports a login that failed with Hermes's reason and leaves the gateway alone", async () => {
    const { model, logins, restarts } = setup();

    const started = model.startDeviceLogin("nous");
    const login = logins[0]?.login;
    login?.line(
      '{"url": "https://portal.nousresearch.com/device", "code": "XYZ", "expires_in": 900}',
    );
    await started;
    login?.line('{"status": "expired", "error": "The code expired before it was approved."}');
    login?.exit(1);
    await model.settled();

    expect(model.deviceLogin()).toMatchObject({
      status: "failed",
      error: "The code expired before it was approved.",
    });
    expect(restarts).toEqual([]);
  });

  it("fails the start when Hermes exits before giving a code", async () => {
    const { model, logins } = setup();

    const started = model.startDeviceLogin("xai-oauth");
    logins[0]?.login.exit(1);

    await expect(started).rejects.toThrow(ModelError);
    expect(model.deviceLogin()).toMatchObject({ status: "failed" });
  });

  it("replaces a login still waiting when a new one starts", async () => {
    const { model, logins } = setup();
    const first = model.startDeviceLogin("nous");
    logins[0]?.login.line('{"url": "https://a/", "code": "ONE", "expires_in": 900}');
    await first;

    const second = model.startDeviceLogin("openai-codex");
    logins[1]?.login.line('{"url": "https://b/", "code": "TWO", "expires_in": 900}');
    await second;
    await logins[0]?.login.process.done;

    expect(model.deviceLogin()).toMatchObject({ provider: "openai-codex", code: "TWO" });
  });
});
