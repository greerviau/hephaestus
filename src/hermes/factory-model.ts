import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { ROLE_NAMES } from "../config/document.js";
import { jsonLine, lastJsonLine, type HermesRun } from "./cli.js";

/** One provider as Hermes's own model picker lists it. */
export interface ProviderRow {
  slug: string;
  name: string;
  /** `api_key`, `oauth_device_code`, `oauth_external`, `aws_sdk`, and so on, as Hermes names them. */
  auth_type: string;
  /** The variable an API key goes in, when the provider takes one. */
  key_env: string;
  authenticated: boolean;
  models: string[];
}

/** A provider Hermes's dashboard signs in through OAuth. */
export interface OAuthRow {
  id: string;
  name: string;
  /** `device_code` signs in from the dashboard; `external` needs a command on the host. */
  flow: string;
  cli_command: string;
}

/** What the `hermes hephaestus catalog` action prints. */
export interface ModelCatalog {
  provider: string;
  model: string;
  providers: ProviderRow[];
  oauth: OAuthRow[];
  profiles: Record<string, { provider: string; model: string }>;
}

/** A device-code sign-in in progress or finished. */
export interface DeviceLogin {
  provider: string;
  url?: string;
  code?: string;
  status: "starting" | "waiting" | "signed-in" | "failed";
  error?: string;
}

/** A running `hermes hephaestus login`, one JSON line at a time. */
export interface LoginProcess {
  onLine(listener: (line: string) => void): void;
  /** Resolves with the exit code. */
  done: Promise<number>;
  stop(): void;
}

/** A refusal the owner can act on; its message is safe to show. */
export class ModelError extends Error {}

/** Hermes would save the model but warned, for example that the provider does not list it. */
export class ModelWarning extends ModelError {}

/** Hermes refused while saving, after the model was written to some of the factory. */
export class ModelPartial extends ModelError {}

export interface FactoryModelOptions {
  /** Whether a deploy has installed the Hephaestus plugin and created the three role profiles. */
  ready: () => boolean;
  /** Runs `hermes` against the factory root. */
  run: HermesRun;
  /** Restarts the factory gateway, so the chat picks up the new model. */
  restartGateway: () => Promise<void>;
  /** Starts `hermes hephaestus login --provider <provider>` against the factory root. */
  startLogin: (provider: string) => LoginProcess;
}

const PROFILES = ROLE_NAMES.join(",");
const OUT_OF_DATE =
  "Hermes did not answer as expected. Update Hermes, or set the model with `hermes model` on the Hermes host.";

/**
 * Gives the factory Hermes a provider and model through the Hephaestus
 * plugin, which calls the same Hermes code as Hermes's own dashboard. Every
 * change covers the factory root and the planner, lead, and improver
 * profiles, and restarts the gateway so the chat uses it.
 */
export class FactoryModel {
  private login: DeviceLogin | undefined;
  private process: LoginProcess | undefined;
  private finishing: Promise<void> = Promise.resolve();

  constructor(private readonly options: FactoryModelOptions) {}

  ready(): boolean {
    return this.options.ready();
  }

  async catalog(): Promise<ModelCatalog> {
    const catalog = (await this.call(["catalog", "--profiles", PROFILES])) as Partial<ModelCatalog>;
    if (!Array.isArray(catalog.providers)) throw this.outdated(catalog);
    return catalog as ModelCatalog;
  }

  async addKey(provider: string, key: string): Promise<void> {
    const trimmed = key.trim();
    if (trimmed === "") throw new ModelError("Paste the key first.");
    await this.call(["add-key", "--provider", provider, "--profiles", PROFILES], trimmed);
    await this.options.restartGateway();
  }

  async setModel(choice: {
    provider: string;
    model: string;
    baseUrl?: string;
    key?: string;
    /** Save even when Hermes warns about the model. */
    force?: boolean;
  }): Promise<void> {
    if (choice.model.trim() === "") throw new ModelError("Pick or type a model.");
    const args = [
      "set-model",
      "--provider",
      choice.provider,
      "--model",
      choice.model.trim(),
      "--profiles",
      PROFILES,
    ];
    if (choice.force === true) args.push("--force");
    // The endpoint URL can carry credentials too, so it goes on stdin with the key.
    const secrets = JSON.stringify({
      api_key: choice.key?.trim() ?? "",
      base_url: choice.baseUrl?.trim() ?? "",
    });
    await this.call(args, secrets);
    await this.options.restartGateway();
  }

  /** The current or last device login. */
  deviceLogin(): DeviceLogin | undefined {
    return this.login === undefined ? undefined : { ...this.login };
  }

  /** Resolves once the current login has finished and its follow-up ran; for tests. */
  settled(): Promise<void> {
    return this.finishing;
  }

  /**
   * Starts a device-code sign-in and resolves once Hermes gives the link and
   * code. The sign-in keeps waiting in the background until the owner
   * approves it, the code expires, or another sign-in replaces it.
   */
  startDeviceLogin(provider: string): Promise<DeviceLogin> {
    this.process?.stop();
    const process = this.options.startLogin(provider);
    const login: DeviceLogin = { provider, status: "starting" };
    this.process = process;
    this.login = login;
    const current = (): boolean => this.process === process;

    let shown: (value: DeviceLogin) => void = () => undefined;
    let refused: (error: Error) => void = () => undefined;
    const started = new Promise<DeviceLogin>((resolve, reject) => {
      shown = resolve;
      refused = reject;
    });
    const fail = (error: string): void => {
      Object.assign(login, { status: "failed", error });
    };

    process.onLine((line) => {
      const message = jsonLine(line) as
        (Outcome & { url?: string; code?: string; status?: string; error?: string }) | undefined;
      if (message === undefined || !current()) return;
      if (message.url !== undefined && message.code !== undefined) {
        Object.assign(login, { url: message.url, code: message.code, status: "waiting" });
        shown({ ...login });
      } else if (message.refused !== undefined) {
        fail(message.refused);
      } else if (message.outdated !== undefined) {
        console.error("The factory Hermes sign-in could not start", message.outdated);
        fail(OUT_OF_DATE);
      } else if (message.status !== undefined) {
        if (message.status === "approved") login.status = "signed-in";
        else fail(message.error || `The sign-in ended: ${message.status}.`);
      }
    });

    this.finishing = process.done.then(async (code) => {
      if (!current()) {
        // Replaced by a newer sign-in; a caller still waiting for this one's code stops waiting.
        refused(new ModelError("Another sign-in replaced this one."));
        return;
      }
      this.process = undefined;
      if (login.status === "signed-in") {
        try {
          await this.options.restartGateway();
        } catch (error) {
          console.error("Restarting the factory gateway after a sign-in failed", error);
          login.error =
            "Signed in, but the factory's chat did not restart. Restart it on the Chat page.";
        }
        return;
      }
      if (login.status !== "failed") {
        fail(
          login.code === undefined ? OUT_OF_DATE : `The sign-in ended with code ${String(code)}.`,
        );
      }
      refused(new ModelError(login.error ?? OUT_OF_DATE));
    });
    return started;
  }

  /**
   * Runs one plugin action and returns its JSON result. The plugin reports a
   * refusal, a partial save, a warning, or missing Hermes code as JSON on stdout, so the
   * reason survives however much Hermes prints on stderr.
   */
  private async call(args: string[], input?: string): Promise<Record<string, unknown>> {
    let output: string;
    try {
      output = await this.options.run(
        ["hephaestus", ...args],
        input === undefined ? undefined : { input },
      );
    } catch (error) {
      console.error("A factory Hermes model action failed", error);
      throw new ModelError(OUT_OF_DATE);
    }
    const result = lastJsonLine(output) as (Outcome & Record<string, unknown>) | undefined;
    if (result === undefined) throw this.outdated(output);
    if (typeof result.refused === "string") throw new ModelError(result.refused);
    if (typeof result.warning === "string") throw new ModelWarning(result.warning);
    if (typeof result.partial === "string") throw new ModelPartial(result.partial);
    if (typeof result.outdated === "string") throw this.outdated(result.outdated);
    return result;
  }

  private outdated(detail: unknown): ModelError {
    console.error("The factory Hermes model plugin did not answer as expected", detail);
    return new ModelError(OUT_OF_DATE);
  }
}

/** How the plugin reports an action that did not happen. */
interface Outcome {
  refused?: string;
  partial?: string;
  warning?: string;
  outdated?: string;
}

/** Runs `hermes hephaestus login` with HERMES_HOME set to the factory root. */
export function spawnLogin(hermesPath: string, root: string): (provider: string) => LoginProcess {
  return (provider) => {
    const child = spawn(hermesPath, ["hephaestus", "login", "--provider", provider], {
      env: { ...process.env, HERMES_HOME: root, HERMES_KANBAN_HOME: root, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    const done = new Promise<number>((resolve) => {
      child.on("error", () => {
        resolve(1);
      });
      child.on("close", (code) => {
        resolve(code ?? 1);
      });
    });
    return {
      onLine: (listener) => {
        lines.on("line", listener);
      },
      done,
      stop: () => {
        child.kill("SIGTERM");
      },
    };
  };
}
