import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Runs the real plugin in `templates/hermes/plugin/hephaestus/` against stub
 * Hermes modules that keep each scope's config and .env in a JSON file, so
 * these tests check what the plugin asks Hermes to do in each scope.
 */
const PLUGIN = fileURLToPath(
  new URL("../../templates/hermes/plugin/hephaestus/__init__.py", import.meta.url),
);
const PYTHON = spawnSync("python3", ["--version"]).status === 0 ? "python3" : undefined;

const STUBS: Record<string, string> = {
  "hermes_cli/__init__.py": "",
  "hermes_cli/web_routers/__init__.py": "",
  "hermes_cli/_state.py": `
import json, os
PATH = os.environ["STUB_STATE"]
CURRENT = ["root"]
def load():
    with open(PATH) as f:
        return json.load(f)
def save(state):
    with open(PATH, "w") as f:
        json.dump(state, f)
def scope():
    state = load()
    return state, state["scopes"].setdefault(CURRENT[0], {"env": {}, "model": {}})
`,
  "hermes_cli/web_server_profiles.py": `
from contextlib import contextmanager
from hermes_cli import _state
@contextmanager
def _profile_scope(profile):
    if profile in _state.load().get("missing", []):
        error = RuntimeError("404")
        error.detail = f"Profile '{profile}' does not exist."
        raise error
    previous = _state.CURRENT[0]
    _state.CURRENT[0] = profile or "root"
    try:
        yield None
    finally:
        _state.CURRENT[0] = previous
`,
  "hermes_cli/config.py": `
from hermes_cli import _state
def load_config():
    return {"model": dict(_state.scope()[1]["model"])}
def load_env():
    return dict(_state.scope()[1]["env"])
`,
  "hermes_cli/credential_lifecycle.py": `
from hermes_cli import _state
def save_provider_env_credential(name, value):
    state, scope = _state.scope()
    scope["env"][name] = value
    _state.save(state)
def remove_provider_env_credential(name):
    state, scope = _state.scope()
    scope["env"].pop(name, None)
    _state.save(state)
`,
  "hermes_cli/auth.py": `
class Config:
    def __init__(self, name, auth_type, env):
        self.name, self.auth_type, self.api_key_env_vars = name, auth_type, env
PROVIDER_REGISTRY = {
    "anthropic": Config("Anthropic", "api_key", ("ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN")),
    "deepseek": Config("DeepSeek", "api_key", ("DEEPSEEK_API_KEY",)),
    "bedrock": Config("AWS Bedrock", "aws_sdk", ()),
}
`,
  "hermes_cli/inventory.py": `
def load_picker_context():
    return None
def build_models_payload(ctx, **options):
    assert not options.get("non_blocking_catalogs")
    return {"provider": "anthropic", "model": "claude-sonnet-5", "providers": [
        {"slug": "anthropic", "name": "Anthropic", "authenticated": True, "models": ["claude-sonnet-5"]},
        {"slug": "deepseek", "name": "DeepSeek", "auth_type": "api_key", "key_env": "DEEPSEEK_API_KEY", "models": []},
    ]}
`,
  "hermes_cli/web_server_config.py": `
from types import SimpleNamespace
from hermes_cli import _state
def _prepare_main_assignment(cfg, provider, model, base_url, api_key):
    state, _ = _state.scope()
    state.setdefault("prepared", []).append([_state.CURRENT[0], base_url, api_key])
    _state.save(state)
    if _state.CURRENT[0] in state.get("refuse_in", []):
        raise RuntimeError("No usable credentials found")
    warning = state.get("warn_in", {}).get(_state.CURRENT[0], "")
    return base_url, SimpleNamespace(warning_message=warning, target_provider=provider, new_model=model)
def _apply_main_assignment_sync(cfg, provider, model, base_url, api_key, prepared=None):
    assert prepared is not None, "applied without the checked result"
    state, scope = _state.scope()
    if _state.CURRENT[0] in state.get("refuse_apply_in", []):
        raise RuntimeError("LAB_API_KEY is read by another endpoint's block")
    scope["model"] = {"provider": provider, "default": model}
    _state.save(state)
    return {"ok": True}
`,
  "hermes_cli/web_server_oauth.py": `
import threading
_oauth_sessions = {"s1": {"status": "approved"}}
_oauth_sessions_lock = threading.Lock()
`,
  "hermes_cli/web_routers/oauth.py": `
def _build_oauth_catalog():
    return [{"id": "openai-codex", "name": "Codex", "flow": "device_code", "cli_command": "hermes auth add openai-codex", "status_fn": len}]
async def _start_device_code_flow(provider):
    if provider == "broken":
        raise RuntimeError("504 from the provider")
    return {"session_id": "s1", "verification_url": "https://example/device", "user_code": "AB-12", "expires_in": 900}
`,
};

const DRIVER = `
import argparse, importlib.util, sys
spec = importlib.util.spec_from_file_location("hephaestus_plugin", sys.argv[1])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
class Context:
    def register_cli_command(self, name, help, setup_fn, handler_fn, description=""):
        self.setup, self.handler = setup_fn, handler_fn
context = Context()
plugin.register(context)
parser = argparse.ArgumentParser()
context.setup(parser)
context.handler(parser.parse_args(sys.argv[2:]))
`;

const SCOPES = ["root", "planner", "lead", "improver"];
const PROFILES = ["--profiles", "planner,lead,improver"];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hephaestus-plugin-"));
  for (const [path, text] of Object.entries(STUBS)) {
    mkdirSync(join(dir, "stubs", path, ".."), { recursive: true });
    writeFileSync(join(dir, "stubs", path), text);
  }
  writeFileSync(join(dir, "driver.py"), DRIVER);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Scope {
  env: Record<string, string>;
  model: Record<string, string>;
}
interface State {
  scopes: Record<string, Scope>;
  refuse_in?: string[];
  refuse_apply_in?: string[];
  missing?: string[];
  warn_in?: Record<string, string>;
  prepared?: [string, string, string][];
}

function seed(extra: Partial<State> = {}): void {
  const scopes = Object.fromEntries(
    SCOPES.map((name) => [name, { env: {}, model: { provider: "anthropic", default: "old" } }]),
  );
  writeFileSync(join(dir, "state.json"), JSON.stringify({ scopes, ...extra }));
}

function state(): State {
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as State;
}

/** Runs one plugin action and returns its JSON lines. */
function run(args: string[], input = ""): Record<string, unknown>[] {
  const output = execFileSync(PYTHON ?? "python3", [join(dir, "driver.py"), PLUGIN, ...args], {
    input,
    env: {
      ...process.env,
      PYTHONPATH: join(dir, "stubs"),
      PYTHONDONTWRITEBYTECODE: "1",
      STUB_STATE: join(dir, "state.json"),
    },
    encoding: "utf8",
  });
  return output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function models(): Record<string, string | undefined> {
  return Object.fromEntries(SCOPES.map((name) => [name, state().scopes[name]?.model.default]));
}

describe.skipIf(PYTHON === undefined)("the Hephaestus Hermes plugin", () => {
  it("checks every scope before writing, so a profile's refusal changes nothing", () => {
    seed({ refuse_in: ["planner"] });

    const output = run(["set-model", "--provider", "anthropic", "--model", "new", ...PROFILES]);

    expect(output).toEqual([
      {
        refused:
          "Hermes refused the model (for the factory's planner profile): No usable credentials found",
      },
    ]);
    expect(models()).toEqual({ root: "old", planner: "old", lead: "old", improver: "old" });
  });

  it("sets the model in every scope with the checked result", () => {
    seed();

    const output = run(["set-model", "--provider", "anthropic", "--model", "new", ...PROFILES]);

    expect(output).toEqual([{ ok: true, provider: "anthropic", model: "new" }]);
    expect(models()).toEqual({ root: "new", planner: "new", lead: "new", improver: "new" });
  });

  it("stops on a warning from any scope unless forced", () => {
    seed({ warn_in: { lead: "`new` was not found." } });

    expect(run(["set-model", "--provider", "anthropic", "--model", "new", ...PROFILES])).toEqual([
      { warning: "`new` was not found." },
    ]);
    expect(models().root).toBe("old");

    run(["set-model", "--provider", "anthropic", "--model", "new", "--force", ...PROFILES]);
    expect(models()).toEqual({ root: "new", planner: "new", lead: "new", improver: "new" });
  });

  it("reads a custom endpoint's URL and key from stdin", () => {
    seed();

    run(
      ["set-model", "--provider", "custom", "--model", "llama", ...PROFILES],
      JSON.stringify({ api_key: "k1", base_url: "http://localhost:8080/v1" }),
    );

    expect(state().prepared?.[0]).toEqual(["root", "http://localhost:8080/v1", "k1"]);
  });

  it("saves a key to every scope, and an Anthropic key replaces a setup-token there", () => {
    seed();

    run(["add-key", "--provider", "anthropic", ...PROFILES], "sk-ant-oat01-token");
    expect(state().scopes.lead?.env).toEqual({ ANTHROPIC_TOKEN: "sk-ant-oat01-token" });

    const output = run(["add-key", "--provider", "anthropic", ...PROFILES], "sk-ant-api03-key\n");

    expect(output).toEqual([{ ok: true, env: "ANTHROPIC_API_KEY" }]);
    for (const name of SCOPES) {
      expect(state().scopes[name]?.env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-api03-key" });
    }
  });

  it("refuses a key for a provider that signs in another way", () => {
    seed();

    expect(run(["add-key", "--provider", "bedrock", ...PROFILES], "k")).toEqual([
      { refused: "AWS Bedrock does not take an API key." },
    ]);
  });

  it("prints a device login's link and code, then its outcome", () => {
    seed();

    expect(run(["login", "--provider", "openai-codex"])).toEqual([
      { url: "https://example/device", code: "AB-12", expires_in: 900 },
      { status: "approved", error: "" },
    ]);
  });

  it("reports a sign-in Hermes could not start", () => {
    seed();

    expect(run(["login", "--provider", "broken"])).toEqual([
      { refused: "Hermes could not start the sign-in: 504 from the provider" },
    ]);
  });

  it("fills a provider's auth hints from the registry", () => {
    seed();

    const [catalog] = run(["catalog", ...PROFILES]) as [
      { providers: { slug: string; auth_type: string; key_env: string }[] },
    ];

    expect(catalog.providers[0]).toMatchObject({
      slug: "anthropic",
      auth_type: "api_key",
      key_env: "ANTHROPIC_API_KEY",
    });
  });

  it("says Hermes is out of date when code it calls is missing", () => {
    seed();
    writeFileSync(join(dir, "stubs", "hermes_cli", "web_routers", "oauth.py"), "");

    const [result] = run(["catalog", ...PROFILES]);

    expect(result?.outdated).toMatch(/^ImportError: cannot import name '_build_oauth_catalog'/);
  });

  it("says which scopes were saved when Hermes refuses while writing", () => {
    seed({ refuse_apply_in: ["lead"] });

    const output = run(["set-model", "--provider", "custom", "--model", "llama", ...PROFILES]);

    expect(output).toEqual([
      {
        partial:
          "Hermes refused the model while saving it (saved for the root, planner so far): LAB_API_KEY is read by another endpoint's block",
      },
    ]);
  });

  it("refuses before writing anything when a profile is missing", () => {
    seed({ missing: ["lead"] });

    const output = run(["add-key", "--provider", "deepseek", ...PROFILES], "k");

    expect(output[0]?.refused).toMatch(/^Hermes could not open the factory's lead profile/);
    expect(state().scopes.root?.env).toEqual({});
    expect(state().scopes.planner?.env).toEqual({});
  });

  it("turns any other refusal Hermes's dashboard code raises into a refusal", () => {
    seed({ missing: ["planner"] });

    expect(run(["catalog", ...PROFILES])).toEqual([
      { refused: "Profile 'planner' does not exist." },
    ]);
  });

  it("reports a refusal while writing the root as a plain refusal", () => {
    seed({ refuse_apply_in: ["root"] });

    expect(run(["set-model", "--provider", "custom", "--model", "llama", ...PROFILES])).toEqual([
      { refused: "Hermes refused the model: LAB_API_KEY is read by another endpoint's block" },
    ]);
  });

  it("says Hermes is out of date, not that a profile is missing, when scope code moved", () => {
    seed();
    writeFileSync(
      join(dir, "stubs", "hermes_cli", "web_server_profiles.py"),
      "from contextlib import contextmanager\n@contextmanager\ndef _profile_scope(profile):\n    from agent.secret_scope import x\n    yield None\n",
    );

    const [result] = run(["add-key", "--provider", "deepseek", ...PROFILES], "k");

    expect(result?.outdated).toMatch(/^ModuleNotFoundError|^ImportError/);
  });
});
