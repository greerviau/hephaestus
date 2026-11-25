#!/usr/bin/env bash
# Stores a Claude setup token in the Factory Claude instance on this worker.
# Usage: set-claude-token.sh <file that holds the token>
set -euo pipefail
secret_file=$1
settings=${T3CODE_HOME:-$HOME/.t3}/userdata/settings.json
trap 'rm -f "$secret_file"' EXIT
python3 - "$settings" "$secret_file" <<'PY'
import re, sys
def update_settings(path, change):
    """Applies change(settings) to T3's settings file under a lock, retrying if T3 wrote it meanwhile."""
    import fcntl, json, os, tempfile
    lock_dir = os.path.join(os.environ["HOME"], ".hephaestus")
    os.makedirs(lock_dir, mode=0o700, exist_ok=True)
    with open(os.path.join(lock_dir, "settings.lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        for _ in range(10):
            before = os.stat(path).st_mtime_ns if os.path.exists(path) else None
            settings = json.load(open(path)) if before is not None else {}
            result = change(settings)
            if result is None:
                return None
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".hephaestus-", suffix=".tmp")
            with os.fdopen(fd, "w") as f:
                json.dump(settings, f, indent=2)
                f.write("\n")
            os.chmod(tmp, 0o600)
            after = os.stat(path).st_mtime_ns if os.path.exists(path) else None
            if after != before:
                os.remove(tmp)
                continue
            os.replace(tmp, path)
            return result
        raise SystemExit("T3 kept changing its settings file; try again")
path, secret_file = sys.argv[1], sys.argv[2]
# A terminal wraps the long token, and a paste can carry the line breaks.
token = re.sub(r"\s+", "", open(secret_file).read())
if not re.fullmatch(r"[A-Za-z0-9_\-]+", token):
    print("TOKEN-FAILED the pasted value is not a Claude setup token")
    sys.exit(1)
def change(settings):
    entry = settings.get("providerInstances", {}).get("hephaestus-claude")
    if entry is None:
        print("TOKEN-FAILED Factory Claude is not set up; deploy first")
        sys.exit(1)
    env = [e for e in entry.get("environment", []) if e.get("name") != "CLAUDE_CODE_OAUTH_TOKEN"]
    env.append({"name": "CLAUDE_CODE_OAUTH_TOKEN", "value": token, "sensitive": True})
    entry["environment"] = env
    return "set"
update_settings(path, change)
print("TOKEN-SET length=%d" % len(token))
PY
