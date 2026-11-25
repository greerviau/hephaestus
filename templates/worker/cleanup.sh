#!/usr/bin/env bash
# Removes everything Hephaestus added to this worker: the factory Codex login,
# the two factory provider instances, and ~/.hephaestus. If the instances
# cannot be removed, ~/.hephaestus stays, so the cleanup can run again.
set -euo pipefail
settings=${T3CODE_HOME:-$HOME/.t3}/userdata/settings.json
if [ -f "$HOME/.hephaestus/codex/auth.json" ]; then
  if ! CODEX_HOME=$HOME/.hephaestus/codex codex logout >/dev/null 2>&1; then
    echo "CLEANUP-FAILED codex logout failed for the factory login; run the cleanup again"
    exit 1
  fi
fi
if [ -e "$settings" ]; then
  removed=$(python3 - "$settings" <<'PY'
import sys
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
removed = []
def change(settings):
    instances = settings.get("providerInstances", {})
    for key in ("hephaestus-claude", "hephaestus-codex"):
        if instances.pop(key, None) is not None:
            removed.append(key)
    if not removed:
        return None
    if not instances:
        settings.pop("providerInstances", None)
    return "removed"
update_settings(sys.argv[1], change)
print(",".join(removed) or "none")
PY
  )
else
  removed=none
fi
rm -rf "$HOME/.hephaestus"
if [ -e "$HOME/.hephaestus" ]; then
  echo "CLEANUP-FAILED ~/.hephaestus could not be removed"
  exit 1
fi
echo "CLEANED instances=$removed hephaestus=removed"
