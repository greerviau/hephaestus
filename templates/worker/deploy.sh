#!/usr/bin/env bash
# Installs one config version on this worker and keeps the two factory
# provider instances in T3's settings. Hephaestus sends this script inline in
# a deploy thread; the config repo cannot change it.
# Usage: deploy.sh <version> <commit sha> <config repo https url>
set -euo pipefail
version=$1 sha=$2 repo_url=$3
tag="v$version"
root=$HOME/.hephaestus
cfg=$root/config
settings=${T3CODE_HOME:-$HOME/.t3}/userdata/settings.json
umask 077
mkdir -p "$cfg/versions" "$root/claude" "$root/codex"

if [ -d "$cfg/repo/.git" ]; then
  git -C "$cfg/repo" remote set-url origin "$repo_url"
  git -C "$cfg/repo" fetch -q --force --tags origin
else
  git clone -q --no-checkout "$repo_url" "$cfg/repo"
  git -C "$cfg/repo" fetch -q --force --tags origin
fi
head=$(git -C "$cfg/repo" rev-parse "$tag^{commit}")
if [ "$head" != "$sha" ]; then
  echo "DEPLOY-FAILED tag $tag is $head, expected $sha"
  exit 1
fi
if [ ! -d "$cfg/versions/$sha" ]; then
  tmp=$(mktemp -d "$cfg/versions/.tmp.XXXXXX")
  git -C "$cfg/repo" archive "$sha" | tar -x -C "$tmp"
  mv -T "$tmp" "$cfg/versions/$sha"
fi
ln -sfn "versions/$sha" "$cfg/.current.tmp"
mv -T "$cfg/.current.tmp" "$cfg/current"
ln -sfn ../config/current/claude/CLAUDE.md "$root/claude/CLAUDE.md"
ln -sfn ../config/current/claude/skills "$root/claude/skills"
ln -sfn ../config/current/codex/AGENTS.md "$root/codex/AGENTS.md"

# Codex resolves skill paths and keeps the list it first found, so its skills
# directory is a real one with a symlink per skill that each deploy rewrites.
[ -L "$root/codex/skills" ] && rm "$root/codex/skills"
mkdir -p "$root/codex/skills"
for link in "$root/codex/skills"/*; do
  if [ -L "$link" ]; then rm "$link"; fi
done
for dir in "$cfg/versions/$sha/codex/skills"/*/; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")
  ln -sfn "../../config/versions/$sha/codex/skills/$name" "$root/codex/skills/$name"
done

python3 - "$root" "$HOME" <<'PY'
import glob, json, os, sys
root, home = sys.argv[1], sys.argv[2]
# Claude Code loads .claude/CLAUDE.md from every parent of the working directory.
path = os.path.join(root, "claude", "settings.json")
data = json.load(open(path)) if os.path.exists(path) else {}
data["claudeMdExcludes"] = [os.path.join(home, p) for p in
    (".claude/CLAUDE.md", ".claude/rules/**", "CLAUDE.md", "CLAUDE.local.md")]
with open(path + ".tmp", "w") as f:
    json.dump(data, f, indent=2)
os.replace(path + ".tmp", path)
# Codex reads the owner's ~/.agents/skills whatever CODEX_HOME is.
path = os.path.join(root, "codex", "config.toml")
begin, end = "# BEGIN hephaestus managed", "# END hephaestus managed"
text = open(path).read() if os.path.exists(path) else ""
if begin in text and end in text:
    text = text[:text.index(begin)] + text[text.index(end) + len(end):].lstrip("\n")
block = [begin]
for skill in sorted(glob.glob(os.path.join(home, ".agents", "skills", "*", "SKILL.md"))):
    block += ["[[skills.config]]", "path = %s" % json.dumps(skill), "enabled = false", ""]
block.append(end)
with open(path + ".tmp", "w") as f:
    f.write(text.rstrip("\n") + ("\n\n" if text.strip() else "") + "\n".join(block) + "\n")
os.replace(path + ".tmp", path)
PY

instances=$(python3 - "$settings" "$root" <<'PY'
import json, os, shutil, sys, time
path, root = sys.argv[1], sys.argv[2]
want = {
    "hephaestus-claude": {"driver": "claudeAgent", "displayName": "Factory Claude", "enabled": True,
                          "config": {"homePath": os.path.join(root, "claude")}},
    "hephaestus-codex": {"driver": "codex", "displayName": "Factory Codex", "enabled": True,
                         "config": {"homePath": os.path.join(root, "codex")}},
}
def covers(have, need):
    if isinstance(need, dict):
        return isinstance(have, dict) and all(k in have and covers(have[k], v) for k, v in need.items())
    return have == need
settings = json.load(open(path)) if os.path.exists(path) else {}
current = settings.setdefault("providerInstances", {})
changed = [k for k, v in want.items() if not covers(current.get(k), v)]
if not changed:
    print("unchanged")
    sys.exit(0)
if os.path.exists(path):
    shutil.copy2(path, os.path.join(root, "t3-settings.backup-%d.json" % int(time.time())))
for k in changed:
    entry = current.get(k) if isinstance(current.get(k), dict) else {}
    for field, value in want[k].items():
        entry[field] = {**(entry.get(field) or {}), **value} if isinstance(value, dict) else value
    current[k] = entry
tmp = path + ".hephaestus-tmp"
with open(tmp, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
os.chmod(tmp, 0o600)
os.replace(tmp, path)
print("wrote")
PY
)
echo "DEPLOYED version=$version head=$(git -C "$cfg/repo" rev-parse "$sha^{commit}") home=$HOME instances=$instances"
