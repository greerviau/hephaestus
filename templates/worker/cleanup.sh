#!/usr/bin/env bash
# Removes everything Hephaestus added to this worker: the factory Codex login,
# the two factory provider instances, and ~/.hephaestus.
set -uo pipefail
settings=${T3CODE_HOME:-$HOME/.t3}/userdata/settings.json
if [ -d "$HOME/.hephaestus/codex" ]; then
  CODEX_HOME=$HOME/.hephaestus/codex codex logout >/dev/null 2>&1 || true
fi
removed=$(python3 - "$settings" <<'PY'
import json, os, sys
path = sys.argv[1]
if not os.path.exists(path):
    print("none")
    sys.exit(0)
settings = json.load(open(path))
instances = settings.get("providerInstances", {})
removed = [k for k in ("hephaestus-claude", "hephaestus-codex") if instances.pop(k, None) is not None]
if not instances:
    settings.pop("providerInstances", None)
tmp = path + ".hephaestus-tmp"
with open(tmp, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
os.chmod(tmp, 0o600)
os.replace(tmp, path)
print(",".join(removed) or "none")
PY
)
rm -rf "$HOME/.hephaestus"
echo "CLEANED instances=$removed hephaestus=$(test -e "$HOME/.hephaestus" && echo kept || echo removed)"
