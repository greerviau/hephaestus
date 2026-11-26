import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { ROLE_NAMES } from "../config/document.js";
import type { HermesRun } from "./cli.js";

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
  logged_in: boolean;
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

export interface FactoryModelOptions {
  /** Whether the factory Hermes has the Hephaestus plugin yet; a deploy installs it. */
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
    const output = await this.call(["catalog", "--profiles", PROFILES]);
    const catalog = lastJson(output) as ModelCatalog | undefined;
    if (catalog === undefined || !Array.isArray(catalog.providers))
      throw new ModelError(OUT_OF_DATE);
    return catalog;
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
    const baseUrl = choice.baseUrl?.trim() ?? "";
    if (baseUrl !== "") args.push("--base-url", baseUrl);
    const key = choice.key?.trim() ?? "";
    if (key !== "") args.push("--key-on-stdin");
    if (choice.force === true) args.push("--force");
    await this.call(args, key === "" ? undefined : key);
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

    process.onLine((line) => {
      const message = parseJson(line) as
        { url?: string; code?: string; status?: string; error?: string } | undefined;
      if (message === undefined || !current()) return;
      if (message.url !== undefined && message.code !== undefined) {
        Object.assign(login, { url: message.url, code: message.code, status: "waiting" });
        shown({ ...login });
      } else if (message.status !== undefined) {
        Object.assign(
          login,
          message.status === "approved"
            ? { status: "signed-in" }
            : { status: "failed", error: message.error || `The sign-in ended: ${message.status}.` },
        );
      }
    });

    this.finishing = process.done.then(async (code) => {
      if (!current()) return;
      this.process = undefined;
      if (login.status === "signed-in") {
        await this.options.restartGateway();
        return;
      }
      if (login.status !== "failed") {
        Object.assign(login, {
          status: "failed",
          error:
            login.code === undefined ? OUT_OF_DATE : `The sign-in ended with code ${String(code)}.`,
        });
      }
      refused(new ModelError(login.error ?? OUT_OF_DATE));
    });
    return started;
  }

  /** Runs one plugin action, turning Hermes's refusal into a message the owner can read. */
  private async call(args: string[], input?: string): Promise<string> {
    try {
      return await this.options.run(
        ["hephaestus", ...args],
        input === undefined ? undefined : { input },
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const warning = /Hermes warned: (.*)/.exec(text)?.[1];
      if (warning !== undefined) throw new ModelWarning(warning);
      const refusal =
        /(Hermes refused the model: .*|Hermes has no provider named .*|.* does not take an API key\.|The key is empty\.)/.exec(
          text,
        )?.[1];
      if (refusal !== undefined) throw new ModelError(refusal);
      console.error("A factory Hermes model action failed", error);
      throw new ModelError(OUT_OF_DATE);
    }
  }
}

function parseJson(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** The last line of output that is a JSON object; Hermes may print warnings before it. */
function lastJson(output: string): unknown {
  const lines = output.split("\n").reverse();
  for (const line of lines) {
    const value = parseJson(line);
    if (value !== undefined) return value;
  }
  return undefined;
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
