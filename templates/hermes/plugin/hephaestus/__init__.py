"""Hephaestus model setup for the factory Hermes.

Hephaestus installs this plugin in the factory's own Hermes home and runs
`hermes hephaestus <action>` with HERMES_HOME set to that home. Each action
calls the same Hermes code that Hermes's own dashboard uses, so every
provider Hermes supports works here too. Output is JSON on stdout; secrets
arrive on stdin and are never printed.
"""

import asyncio
import json
import sys
import time

# Device-code providers report these session states; anything else is final.
PENDING = "pending"


def _emit(value):
    sys.stdout.write(json.dumps(value, default=str) + "\n")
    sys.stdout.flush()


def _scopes(args):
    """The factory root (None) and each profile named on the command line."""
    profiles = [name for name in (args.profiles or "").split(",") if name]
    return [None, *profiles]


def _catalog(args):
    from hermes_cli.inventory import build_models_payload, load_picker_context
    from hermes_cli.web_routers.oauth import _build_oauth_catalog, _resolve_provider_status
    from hermes_cli.web_server_profiles import _profile_scope

    payload = build_models_payload(load_picker_context(), include_unconfigured=True, picker_hints=True)
    oauth = []
    for entry in _build_oauth_catalog():
        status = _resolve_provider_status(entry["id"], entry.get("status_fn")) or {}
        oauth.append({
            "id": entry["id"],
            "name": entry["name"],
            "flow": entry["flow"],
            "cli_command": entry.get("cli_command") or "",
            "logged_in": bool(status.get("logged_in")),
        })
    profiles = {}
    for scope in _scopes(args)[1:]:
        with _profile_scope(scope):
            from hermes_cli.config import load_config

            model = load_config().get("model")
            model = model if isinstance(model, dict) else {"default": model or ""}
            profiles[scope] = {"provider": model.get("provider") or "", "model": model.get("default") or ""}
    providers = [
        {
            "slug": row.get("slug"),
            "name": row.get("name"),
            "auth_type": row.get("auth_type") or "",
            "key_env": row.get("key_env") or "",
            "authenticated": bool(row.get("authenticated")),
            "models": list(row.get("models") or []),
        }
        for row in payload.get("providers", [])
    ]
    _emit({
        "provider": payload.get("provider") or "",
        "model": payload.get("model") or "",
        "providers": providers,
        "oauth": oauth,
        "profiles": profiles,
    })


def _env_var_for(slug, key):
    from hermes_cli.auth import PROVIDER_REGISTRY

    config = PROVIDER_REGISTRY.get(slug)
    if config is None:
        raise SystemExit(f"Hermes has no provider named {slug}.")
    if config.auth_type != "api_key" or not config.api_key_env_vars:
        raise SystemExit(f"{config.name} does not take an API key.")
    names = list(config.api_key_env_vars)
    # `claude setup-token` prints an OAuth token, which Hermes reads from ANTHROPIC_TOKEN.
    if slug == "anthropic" and key.startswith("sk-ant-oat") and "ANTHROPIC_TOKEN" in names:
        return "ANTHROPIC_TOKEN"
    return names[0]


def _add_key(args):
    from hermes_cli.credential_lifecycle import save_provider_env_credential
    from hermes_cli.web_server_profiles import _profile_scope

    key = sys.stdin.read().strip()
    if not key:
        raise SystemExit("The key is empty.")
    env_var = _env_var_for(args.provider, key)
    # A profile reads only its own .env, so the key goes to the root and to every profile.
    for scope in _scopes(args):
        with _profile_scope(scope):
            save_provider_env_credential(env_var, key)
    _emit({"ok": True, "env": env_var})


def _login(args):
    from hermes_cli.web_routers.oauth import _start_device_code_flow
    from hermes_cli.web_server_oauth import _oauth_sessions, _oauth_sessions_lock

    # Device logins save to the root's auth.json; profiles read it from there.
    started = asyncio.run(_start_device_code_flow(args.provider))
    _emit({
        "url": started["verification_url"],
        "code": started["user_code"],
        "expires_in": started.get("expires_in", 900),
    })
    session_id = started["session_id"]
    deadline = time.time() + int(started.get("expires_in") or 900) + 30
    while time.time() < deadline:
        with _oauth_sessions_lock:
            session = dict(_oauth_sessions.get(session_id) or {})
        status = session.get("status", PENDING)
        if status != PENDING:
            _emit({"status": status, "error": session.get("error_message") or ""})
            sys.exit(0 if status == "approved" else 1)
        time.sleep(1)
    _emit({"status": "expired", "error": "The code expired before it was approved."})
    sys.exit(1)


def _set_model(args):
    from hermes_cli.config import load_config
    from hermes_cli.web_server_config import _apply_main_assignment_sync
    from hermes_cli.web_server_profiles import _profile_scope

    api_key = sys.stdin.read().strip() if args.key_on_stdin else ""
    chosen = None
    for scope in _scopes(args):
        with _profile_scope(scope):
            try:
                _apply_main_assignment_sync(load_config(), args.provider, args.model, args.base_url or "", api_key)
            except Exception as error:
                detail = getattr(error, "detail", None) or str(error)
                raise SystemExit(f"Hermes refused the model: {detail}") from None
            model = load_config().get("model") or {}
            chosen = chosen or {"provider": model.get("provider"), "model": model.get("default")}
    _emit({"ok": True, **(chosen or {})})


ACTIONS = {"catalog": _catalog, "add-key": _add_key, "login": _login, "set-model": _set_model}


def _setup(parser):
    actions = parser.add_subparsers(dest="hephaestus_action", required=True)
    catalog = actions.add_parser("catalog", help="List providers, models, and sign-in state as JSON")
    catalog.add_argument("--profiles", default="")
    add_key = actions.add_parser("add-key", help="Save an API key read from stdin")
    add_key.add_argument("--provider", required=True)
    add_key.add_argument("--profiles", default="")
    login = actions.add_parser("login", help="Start a device-code sign-in and wait for it")
    login.add_argument("--provider", required=True)
    set_model = actions.add_parser("set-model", help="Set the provider and default model")
    set_model.add_argument("--provider", required=True)
    set_model.add_argument("--model", required=True)
    set_model.add_argument("--base-url", default="")
    set_model.add_argument("--key-on-stdin", action="store_true")
    set_model.add_argument("--profiles", default="")


def _handle(args):
    ACTIONS[args.hephaestus_action](args)


def register(ctx):
    ctx.register_cli_command(
        "hephaestus", "Model setup for the Hephaestus factory", _setup, _handle,
        description="Used by the Hephaestus dashboard; not meant to be run by hand.",
    )
