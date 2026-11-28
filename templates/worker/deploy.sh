#!/usr/bin/env bash
# Installs one config version on this worker and keeps the two factory
# provider instances in T3's settings. Hephaestus sends this script inline in
# a deploy thread; the config repo cannot change it.
# Usage: deploy.sh <version> <commit sha> <config repo https url> <tag>
set -euo pipefail
version=$1 sha=$2 repo_url=$3 tag=$4
# T3 gives its threads T3CODE_HOME, so a run under a scratch HOME would point
# T3's real factory instances at a folder that is later deleted.
account_home=$(getent passwd "$(id -un)" | cut -d: -f6)
if [ "$HOME" != "$account_home" ]; then
  echo "DEPLOY-FAILED HOME is $HOME, not this account's home folder $account_home"
  exit 1
fi
root=$HOME/.hephaestus
cfg=$root/config
settings=${T3CODE_HOME:-$HOME/.t3}/userdata/settings.json
umask 077
mkdir -p "$cfg/versions" "$root/claude/skills" "$root/codex/skills"
export GIT_TERMINAL_PROMPT=0
gh_path=$(command -v gh || true)
git_() {
  if [ -n "$gh_path" ]; then
    git -c credential.helper= -c "credential.https://github.com.helper=!$gh_path auth git-credential" "$@"
  else
    git "$@"
  fi
}

if [ -d "$cfg/repo/.git" ]; then
  git -C "$cfg/repo" remote set-url origin "$repo_url"
else
  git_ clone -q --no-checkout "$repo_url" "$cfg/repo"
fi
git_ -C "$cfg/repo" fetch -q --force origin "+refs/tags/$tag:refs/tags/$tag"
head=$(git -C "$cfg/repo" rev-parse "refs/tags/$tag^{commit}")
if [ "$head" != "$sha" ]; then
  echo "DEPLOY-FAILED tag $tag is $head, expected $sha"
  exit 1
fi
if [ ! -d "$cfg/versions/$sha" ]; then
  tmp=$(mktemp -d "$cfg/versions/.tmp.XXXXXX")
  # checkout-index writes the commit's tree as it is; git archive would honour export-ignore.
  index=$(mktemp "$cfg/.index.XXXXXX")
  GIT_INDEX_FILE=$index git -C "$cfg/repo" read-tree "$sha"
  GIT_INDEX_FILE=$index git -C "$cfg/repo" checkout-index -a --prefix="$tmp/"
  rm -f "$index"
  mv -T "$tmp" "$cfg/versions/$sha"
fi
installed=$(cat "$cfg/versions/$sha/VERSION" 2>/dev/null || true)
if [ "$installed" != "$version" ]; then
  echo "DEPLOY-FAILED commit $sha holds version ${installed:-none}, expected $version"
  exit 1
fi
ln -sfnT "versions/$sha" "$cfg/.current.tmp"
mv -T "$cfg/.current.tmp" "$cfg/current"
ln -sfnT "../config/versions/$sha/claude/CLAUDE.md" "$root/claude/CLAUDE.md"
ln -sfnT "../config/versions/$sha/codex/AGENTS.md" "$root/codex/AGENTS.md"

# Each skill is a symlink into this version's folder, so a skills directory
# changes on every deploy and an old version's files stay where they were.
for agent in claude codex; do
  dir=$root/$agent/skills
  [ -L "$dir" ] && rm "$dir" && mkdir -p "$dir"
  for link in "$dir"/*; do
    if [ -L "$link" ]; then rm "$link"; fi
  done
  for skill in "$cfg/versions/$sha/$agent/skills"/*/; do
    [ -d "$skill" ] || continue
    name=$(basename "$skill")
    if [ -e "$dir/$name" ] && [ ! -L "$dir/$name" ]; then
      echo "DEPLOY-FAILED $dir/$name is a real folder; remove it so the factory skill can be installed"
      exit 1
    fi
    ln -sfnT "../../config/versions/$sha/$agent/skills/$name" "$dir/$name"
  done
done

# A project's own skills reach only its factory threads. T3 makes each thread's
# worktree from Hephaestus's clone of the repo, so a post-checkout hook in that
# clone links the project's skills, from the version current when the worktree
# is made, into the worktree's .claude/skills and .agents/skills, where Claude
# and Codex load repo skills, and keeps the links out of git status.
hook_mark="# hephaestus: project skills"
for clone in "$root"/projects/*/; do
  [ -d "$clone.git" ] || continue
  key=$(basename "$clone" | tr '[:upper:]' '[:lower:]')
  hook=$clone.git/hooks/post-checkout
  if [ -e "$hook" ] && ! grep -qF "$hook_mark" "$hook"; then
    # A hook Hephaestus did not write stays; only a project with skills needs this one.
    if [ -d "$cfg/versions/$sha/projects/$key/skills" ]; then
      echo "DEPLOY-FAILED $hook is not Hephaestus's; remove it so the project's skills can be installed"
      exit 1
    fi
    continue
  fi
  mkdir -p "$clone.git/hooks"
  cat >"$hook.tmp" <<HOOK
#!/bin/sh
$hook_mark
# Written by Hephaestus's deploy. Links the project's factory skills into a new worktree.
case \$1 in *[!0]*) exit 0 ;; esac
src=\$(readlink -f "$cfg/current")/projects/$key/skills
[ -d "\$src" ] || exit 0
exclude=\$(git rev-parse --git-path info/exclude)
mkdir -p "\$(dirname "\$exclude")"
for skill in "\$src"/*/; do
  [ -d "\$skill" ] || continue
  name=\$(basename "\$skill")
  for dir in .claude/skills .agents/skills; do
    if [ -e "\$dir/\$name" ] || [ -L "\$dir/\$name" ]; then continue; fi
    mkdir -p "\$dir" && ln -s "\${skill%/}" "\$dir/\$name" || continue
    grep -qxF "/\$dir/\$name" "\$exclude" 2>/dev/null || echo "/\$dir/\$name" >>"\$exclude"
  done
done
exit 0
HOOK
  chmod 755 "$hook.tmp"
  mv -f "$hook.tmp" "$hook"
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
# Codex finds skills at any depth under the folder.
for skill in sorted(glob.glob(os.path.join(home, ".agents", "skills", "**", "SKILL.md"), recursive=True)):
    block += ["[[skills.config]]", "path = %s" % json.dumps(skill), "enabled = false", ""]
block.append(end)
with open(path + ".tmp", "w") as f:
    f.write(text.rstrip("\n") + ("\n\n" if text.strip() else "") + "\n".join(block) + "\n")
os.replace(path + ".tmp", path)
PY

instances=$(python3 - "$settings" "$root" <<'PY'
import os, sys
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
def change(settings):
    current = settings.setdefault("providerInstances", {})
    changed = [k for k, v in want.items() if not covers(current.get(k), v)]
    if not changed:
        return None
    for k in changed:
        entry = current.get(k) if isinstance(current.get(k), dict) else {}
        for field, value in want[k].items():
            entry[field] = {**(entry.get(field) or {}), **value} if isinstance(value, dict) else value
        current[k] = entry
    return "wrote"
print(update_settings(path, change) or "unchanged")
PY
)
echo "DEPLOYED version=$version head=$(git -C "$cfg/repo" rev-parse "$sha^{commit}") home=$HOME instances=$instances"
