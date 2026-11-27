"""Hephaestus model setup and board repair for the factory Hermes.

Hephaestus installs this plugin in the factory's own Hermes home and runs
`hermes hephaestus <action>` with HERMES_HOME set to that home. Each action
calls the same Hermes code that Hermes's own dashboard uses, so every
provider Hermes supports works here too, and a task moves the way a drag on
the dashboard's kanban board moves it.

Every action prints JSON lines on stdout. A refusal is `{"refused": ...}`, a
refusal after some scopes were written is `{"partial": ...}`, a warning that
`--force` overrides is `{"warning": ...}`, and Hermes code this plugin cannot
find is `{"outdated": ...}`; all four exit 0 so the reason is
never lost in stderr. Secrets arrive on stdin and are never printed.
"""

import asyncio
import json
import re
import sys
import time

# Device-code providers report these session states; anything else is final.
PENDING = "pending"

# Hermes reads ANTHROPIC_TOKEN (a `claude setup-token` token) before ANTHROPIC_API_KEY,
# so saving one clears the other, as Hermes's own savers do.
ANTHROPIC_SLOTS = ("ANTHROPIC_TOKEN", "ANTHROPIC_API_KEY")


class Refused(Exception):
    """Hermes said no; the message is for the owner."""


class Partial(Exception):
    """Hermes refused while writing, after some scopes were saved."""


class Warned(Exception):
    """Hermes would accept this, but warned; `--force` saves anyway."""


def _emit(value):
    sys.stdout.write(json.dumps(value, default=str) + "\n")
    sys.stdout.flush()


def _detail(error):
    return getattr(error, "detail", None) or str(error)


def _scopes(args):
    """The factory root (None) and each profile named on the command line."""
    profiles = [name for name in (args.profiles or "").split(",") if name]
    return [None, *profiles]


def _stdin_json():
    text = sys.stdin.read()
    if not text.strip():
        return {}
    value = json.loads(text)
    return value if isinstance(value, dict) else {}


def _catalog(args):
    from hermes_cli.auth import PROVIDER_REGISTRY
    from hermes_cli.config import load_config
    from hermes_cli.inventory import build_models_payload, load_picker_context
    from hermes_cli.web_routers.oauth import _build_oauth_catalog
    from hermes_cli.web_server_profiles import _profile_scope

    # Blocking reads, so a missing or very old cached model list is fetched now; Hermes still
    # refreshes a merely stale list in a background thread that may not finish before exit.
    payload = build_models_payload(load_picker_context(), include_unconfigured=True, picker_hints=True)
    oauth = [
        {"id": entry["id"], "name": entry["name"], "flow": entry["flow"], "cli_command": entry.get("cli_command") or ""}
        for entry in _build_oauth_catalog()
    ]
    profiles = {}
    for scope in _scopes(args)[1:]:
        with _profile_scope(scope):
            model = load_config().get("model")
            model = model if isinstance(model, dict) else {"default": model or ""}
            profiles[scope] = {"provider": model.get("provider") or "", "model": model.get("default") or ""}
    providers = []
    for row in payload.get("providers", []):
        # The picker leaves auth hints off some rows, such as the current provider's;
        # the registry has them.
        config = PROVIDER_REGISTRY.get(row.get("slug"))
        auth_type = row.get("auth_type") or (config.auth_type if config else "")
        key_env = row.get("key_env") or (
            config.api_key_env_vars[0] if config and config.api_key_env_vars else ""
        )
        providers.append({
            "slug": row.get("slug"),
            "name": row.get("name"),
            "auth_type": auth_type or "",
            "key_env": key_env or "",
            "authenticated": bool(row.get("authenticated")),
            "models": list(row.get("models") or []),
        })
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
        raise Refused(f"Hermes has no provider named {slug}.")
    if config.auth_type != "api_key" or not config.api_key_env_vars:
        raise Refused(f"{config.name} does not take an API key.")
    names = list(config.api_key_env_vars)
    if slug == "anthropic" and set(ANTHROPIC_SLOTS) <= set(names):
        return "ANTHROPIC_TOKEN" if key.startswith("sk-ant-oat") else "ANTHROPIC_API_KEY"
    return names[0]


def _check_scopes(args):
    """Enters every scope once, so a missing profile refuses before anything is written."""
    from hermes_cli.web_server_profiles import _profile_scope

    for scope in _scopes(args):
        try:
            with _profile_scope(scope):
                pass
        except (ImportError, AttributeError):
            raise
        except Exception as error:
            if scope is None:
                raise Refused(f"Hermes could not open the factory root: {_detail(error)} Deploy a config version.") from None
            # Hermes's reason names the profile, and the planning model page never names the factory's roles.
            raise Refused("Hermes could not open one of the factory's profiles. Deploy a config version.") from None


def _add_key(args):
    from hermes_cli.config import load_env
    from hermes_cli.credential_lifecycle import remove_provider_env_credential, save_provider_env_credential
    from hermes_cli.web_server_profiles import _profile_scope

    key = sys.stdin.read().strip()
    if not key:
        raise Refused("The key is empty.")
    env_var = _env_var_for(args.provider, key)
    stale = [name for name in ANTHROPIC_SLOTS if name != env_var] if env_var in ANTHROPIC_SLOTS else []
    _check_scopes(args)
    # A profile reads only its own .env, so the key goes to the root and to every profile.
    for scope in _scopes(args):
        with _profile_scope(scope):
            for name in stale:
                if load_env().get(name):
                    remove_provider_env_credential(name)
            save_provider_env_credential(env_var, key)
    _emit({"ok": True, "env": env_var})


def _login(args):
    from hermes_cli.web_routers.oauth import _start_device_code_flow
    from hermes_cli.web_server_oauth import _oauth_sessions, _oauth_sessions_lock

    # Device logins save to the root's auth.json; profiles read it from there.
    try:
        started = asyncio.run(_start_device_code_flow(args.provider))
    except (ImportError, AttributeError):
        raise
    except Exception as error:
        raise Refused(f"Hermes could not start the sign-in: {_detail(error)}") from None
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
            return
        time.sleep(1)
    _emit({"status": "expired", "error": "The code expired before it was approved."})


def _set_model(args):
    from hermes_cli.config import load_config
    from hermes_cli.web_server_config import _apply_main_assignment_sync, _prepare_main_assignment
    from hermes_cli.web_server_profiles import _profile_scope

    secrets = _stdin_json()
    api_key = str(secrets.get("api_key") or "").strip()
    base_url = str(secrets.get("base_url") or "").strip()
    scopes = _scopes(args)
    _check_scopes(args)
    # Check every scope before writing any, so a refusal or a warning changes nothing.
    prepared = {}
    for scope in scopes:
        with _profile_scope(scope):
            try:
                prepared[scope] = _prepare_main_assignment(load_config(), args.provider, args.model, base_url, api_key)
            except (ImportError, AttributeError):
                raise
            except Exception as error:
                where = "" if scope is None else " (for one of the factory's profiles)"
                raise Refused(f"Hermes refused the model{where}: {_detail(error)}") from None
    warnings = sorted({result.warning_message for _, result in prepared.values() if result.warning_message})
    if warnings and not args.force:
        raise Warned(" ".join(warnings))
    written = []
    for scope in scopes:
        with _profile_scope(scope):
            try:
                _apply_main_assignment_sync(load_config(), args.provider, args.model, base_url, api_key, prepared[scope])
            except (ImportError, AttributeError):
                raise
            except Exception as error:
                # Hermes can still refuse while writing, for example over a shared key variable.
                if not written:
                    raise Refused(f"Hermes refused the model: {_detail(error)}") from None
                profiles = len(written) - 1
                names = "the root" if profiles == 0 else f"the root and {profiles} of {len(scopes) - 1} profiles"
                raise Partial(
                    f"Hermes refused the model while saving it (saved for {names} so far): {_detail(error)}"
                ) from None
            written.append(scope)
    _, result = prepared[None]
    _emit({"ok": True, "provider": result.target_provider, "model": result.new_model})


def _move_task(args):
    """Moves a task out of triage, where Hermes's unblock-loop breaker parks it and
    no CLI command but a model-driven one moves it again."""
    from hermes_cli import kanban_db
    from plugins.kanban.dashboard import plugin_api

    conn = plugin_api._conn(board=args.board)
    try:
        task = kanban_db.get_task(conn, args.task)
        if task is None:
            raise Refused(f"Task {args.task} is not on board {args.board}.")
        if task.status == "triage":
            moved = plugin_api._set_status_direct(conn, args.task, args.to)
            # Hermes refuses ready while a parent is unfinished; todo waits for the parent instead.
            if not moved and args.to == "ready":
                moved = plugin_api._set_status_direct(conn, args.task, "todo")
            if not moved:
                raise Refused(f"Hermes did not move task {args.task} to {args.to}.")
            task = kanban_db.get_task(conn, args.task)
        _emit({"ok": True, "status": task.status})
    finally:
        conn.close()


ACTIONS = {
    "catalog": _catalog,
    "add-key": _add_key,
    "login": _login,
    "set-model": _set_model,
    "move-task": _move_task,
}


def _setup(parser):
    actions = parser.add_subparsers(dest="hephaestus_action", required=True)
    catalog = actions.add_parser("catalog", help="List providers, models, and sign-in state as JSON")
    catalog.add_argument("--profiles", default="")
    add_key = actions.add_parser("add-key", help="Save an API key read from stdin")
    add_key.add_argument("--provider", required=True)
    add_key.add_argument("--profiles", default="")
    login = actions.add_parser("login", help="Start a device-code sign-in and wait for it")
    login.add_argument("--provider", required=True)
    set_model = actions.add_parser(
        "set-model", help="Set the provider and default model; an endpoint URL and key come as JSON on stdin",
    )
    set_model.add_argument("--provider", required=True)
    set_model.add_argument("--model", required=True)
    set_model.add_argument("--force", action="store_true", help="Save even when Hermes warns")
    set_model.add_argument("--profiles", default="")
    move_task = actions.add_parser(
        "move-task", help="Move a kanban task out of triage, as a drag on Hermes's dashboard does",
    )
    move_task.add_argument("--board", required=True)
    move_task.add_argument("--to", required=True, choices=("ready", "scheduled"))
    move_task.add_argument("task")


def _neutral(text, args):
    """Hermes's reasons can name a profile; the planning model page shows them and never names the factory's roles."""
    names = [name for name in (getattr(args, "profiles", "") or "").split(",") if name]
    for name in names:
        text = re.sub(rf"\b[Pp]rofile '{re.escape(name)}'", "A factory profile", text)
        text = re.sub(rf"'{re.escape(name)}'|\b{re.escape(name)}\b", "a factory profile", text)
    return text


def _handle(args):
    try:
        ACTIONS[args.hephaestus_action](args)
    except Refused as error:
        _emit({"refused": _neutral(str(error), args)})
    except Warned as error:
        _emit({"warning": _neutral(str(error), args)})
    except Partial as error:
        _emit({"partial": _neutral(str(error), args)})
    except (ImportError, AttributeError) as error:
        # Hermes renamed or moved code this plugin calls.
        _emit({"outdated": f"{type(error).__name__}: {error}"})
    except Exception as error:
        # Hermes's dashboard code refuses with an HTTP error that carries a reason.
        if getattr(error, "detail", None) is None:
            raise
        _emit({"refused": _neutral(str(error.detail), args)})


def register(ctx):
    ctx.register_cli_command(
        "hephaestus", "Model setup and board repair for the Hephaestus factory", _setup, _handle,
        description="Used by the Hephaestus dashboard; not meant to be run by hand.",
    )
