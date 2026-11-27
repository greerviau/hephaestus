import { describe, expect, it } from "vitest";
import {
  FactoryModel,
  ModelError,
  ModelPartial,
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
    },
  ],
  profiles: {
    communicator: { provider: "anthropic", model: "claude-sonnet-5" },
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
  stopped(): boolean;
} {
  const listeners: ((line: string) => void)[] = [];
  let stopped = false;
  let finish: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });
  return {
    process: {
      onLine: (listener) => listeners.push(listener),
      done,
      stop: () => {
        stopped = true;
        finish(143);
      },
    },
    line: (text) => {
      for (const listener of listeners) listener(text);
    },
    exit: (code) => {
      finish(code);
    },
    stopped: () => stopped,
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
      { args: ["hephaestus", "catalog", "--profiles", "communicator,lead,improver"] },
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
          "communicator,lead,improver",
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
          "communicator,lead,improver",
        ],
        input: '{"api_key":"","base_url":""}',
      },
    ]);
    expect(restarts).toHaveLength(1);
  });

  it("sends a custom endpoint's URL and key on stdin, never on the command line", async () => {
    const { model, calls } = setup(() => '{"ok": true}\n');

    await model.setModel({
      provider: "custom",
      model: "llama-3",
      baseUrl: "http://user:pass@localhost:8080/v1",
      key: "local-key",
    });

    expect(calls[0]?.input).toBe(
      '{"api_key":"local-key","base_url":"http://user:pass@localhost:8080/v1"}',
    );
    expect(JSON.stringify(calls[0]?.args)).not.toMatch(/local-key|user:pass/);
  });

  it("turns the plugin's refusal into a message the owner can act on, and does not restart", async () => {
    const { model, restarts } = setup(
      () => 'noise\n{"refused": "Hermes refused the model: unknown model nope"}\n',
    );

    await expect(model.setModel({ provider: "anthropic", model: "nope" })).rejects.toThrow(
      "Hermes refused the model: unknown model nope",
    );
    expect(restarts).toEqual([]);
  });

  it("reports the plugin's warning as a warning, and passes --force when the owner insists", async () => {
    const { model, calls } = setup((args) =>
      args.includes("--force") ? '{"ok": true}\n' : '{"warning": "`x` was not found."}\n',
    );

    await expect(model.setModel({ provider: "anthropic", model: "x" })).rejects.toBeInstanceOf(
      ModelWarning,
    );
    await model.setModel({ provider: "anthropic", model: "x", force: true });

    expect(calls[1]?.args).toContain("--force");
  });

  it("reports a save Hermes refused partway as partial", async () => {
    const { model, restarts } = setup(() => '{"partial": "saved for the root so far: 409"}\n');

    await expect(model.setModel({ provider: "custom", model: "x" })).rejects.toBeInstanceOf(
      ModelPartial,
    );
    expect(restarts).toEqual([]);
  });

  it("says Hermes is out of date when the plugin cannot find Hermes code, or Hermes fails", async () => {
    const outdated = setup(() => '{"outdated": "ImportError: cannot import name x"}\n');
    await expect(outdated.model.addKey("deepseek", "k")).rejects.toThrow("Update Hermes");
    expect(outdated.restarts).toEqual([]);

    const failing = new FactoryModel({
      ready: () => true,
      run: () => Promise.reject(new Error("hermes hephaestus add-key failed: Traceback")),
      restartGateway: () => Promise.resolve(),
      startLogin: () => fakeLogin().process,
    });
    await expect(failing.addKey("deepseek", "k")).rejects.toThrow("Update Hermes");
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

  it("keeps a sign-in whose gateway restart failed, says so, and never rejects in the background", async () => {
    const login = fakeLogin();
    const model = new FactoryModel({
      ready: () => true,
      run: () => Promise.resolve(""),
      restartGateway: () => Promise.reject(new Error("the gateway did not restart")),
      startLogin: () => login.process,
    });

    const started = model.startDeviceLogin("nous");
    login.line('{"url": "https://a/", "code": "C", "expires_in": 900}');
    await started;
    login.line('{"status": "approved", "error": ""}');
    login.exit(0);

    await expect(model.settled()).resolves.toBeUndefined();
    expect(model.deviceLogin()).toMatchObject({
      status: "signed-in",
      error: expect.stringContaining("did not restart") as unknown,
    });
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

  it("fails the start with Hermes's reason when the plugin refuses it", async () => {
    const { model, logins } = setup();

    const started = model.startDeviceLogin("xai-oauth");
    logins[0]?.login.line('{"refused": "Hermes could not start the sign-in: 504"}');
    logins[0]?.login.exit(0);

    await expect(started).rejects.toThrow("Hermes could not start the sign-in: 504");
    expect(model.deviceLogin()).toMatchObject({ status: "failed" });
  });

  it("fails the start when Hermes exits before giving a code", async () => {
    const { model, logins } = setup();

    const started = model.startDeviceLogin("xai-oauth");
    logins[0]?.login.exit(1);

    await expect(started).rejects.toThrow("Update Hermes");
    expect(model.deviceLogin()).toMatchObject({ status: "failed" });
  });

  it("stops a login still waiting when a new one starts, and ignores what the old one says", async () => {
    const { model, logins } = setup();
    const first = model.startDeviceLogin("nous");
    logins[0]?.login.line('{"url": "https://a/", "code": "ONE", "expires_in": 900}');
    await first;

    const second = model.startDeviceLogin("openai-codex");
    expect(logins[0]?.login.stopped()).toBe(true);
    logins[0]?.login.line('{"status": "approved", "error": ""}');
    logins[1]?.login.line('{"url": "https://b/", "code": "TWO", "expires_in": 900}');
    await second;

    expect(model.deviceLogin()).toMatchObject({
      provider: "openai-codex",
      code: "TWO",
      status: "waiting",
    });
  });

  it("settles a start that is replaced before its code arrives", async () => {
    const { model } = setup();
    const first = model.startDeviceLogin("nous");
    const second = model.startDeviceLogin("nous");

    await expect(first).rejects.toThrow("replaced");
    expect(model.deviceLogin()).toMatchObject({ status: "starting" });
    void second.catch(() => undefined);
  });
});
