#!/usr/bin/env bash
# Stores a Claude setup token in the Factory Claude instance on this worker.
# Usage: set-claude-token.sh <file that holds the token>
set -euo pipefail
secret_file=$1
settings=${T3CODE_HOME:-$HOME/.t3}/userdata/settings.json
python3 - "$settings" "$secret_file" <<'PY'
import json, os, re, sys
path, secret_file = sys.argv[1], sys.argv[2]
# A terminal wraps the long token, and a paste can carry the line breaks.
token = re.sub(r"\s+", "", open(secret_file).read())
if not re.fullmatch(r"[A-Za-z0-9_\-]+", token):
    print("TOKEN-FAILED the pasted value is not a Claude setup token")
    sys.exit(1)
settings = json.load(open(path))
entry = settings.get("providerInstances", {}).get("hephaestus-claude")
if entry is None:
    print("TOKEN-FAILED Factory Claude is not set up; deploy first")
    sys.exit(1)
env = [e for e in entry.get("environment", []) if e.get("name") != "CLAUDE_CODE_OAUTH_TOKEN"]
env.append({"name": "CLAUDE_CODE_OAUTH_TOKEN", "value": token, "sensitive": True})
entry["environment"] = env
tmp = path + ".hephaestus-tmp"
with open(tmp, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
os.chmod(tmp, 0o600)
os.replace(tmp, path)
print("TOKEN-SET length=%d" % len(token))
PY
rm -f "$secret_file"
