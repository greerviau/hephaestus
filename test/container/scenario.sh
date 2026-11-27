#!/bin/sh
# Install, log in and uninstall as the owner, checking each step.
set -eu

cli="node /opt/hephaestus/dist/cli.js"
port=7700
base="http://127.0.0.1:$port"
password="correct horse battery"
unit="$HOME/.config/systemd/user/hephaestus.service"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Runs a command and stores its exit code in $code without stopping the script.
run() {
  set +e
  "$@"
  code=$?
  set -e
}

hash_of() {
  echo "sha256:$(sha256sum "$1" | cut -d' ' -f1)"
}

wait_for_dashboard() {
  for _ in $(seq 1 30); do
    curl --silent --output /dev/null "$base/login" && return 0
    sleep 1
  done
  fail "dashboard did not start"
}

status() {
  curl --silent --output /dev/null --write-out '%{http_code}' "$@"
}

# Stand-in personal config that install must record and uninstall must check:
# one file per baseline group, a named Hermes profile, and a linked skill.
mkdir -p "$HOME/.hermes/profiles/work" "$HOME/.claude/skills" "$HOME/.codex" \
  "$HOME/.t3/userdata" "$HOME/skills-checkout/review"
echo "model: personal" > "$HOME/.hermes/config.yaml"
echo "model: work" > "$HOME/.hermes/profiles/work/config.yaml"
echo "# personal" > "$HOME/.claude/CLAUDE.md"
echo "# review v1" > "$HOME/skills-checkout/review/SKILL.md"
ln -s "$HOME/skills-checkout/review" "$HOME/.claude/skills/review"
echo "model = 'personal'" > "$HOME/.codex/config.toml"
echo "{}" > "$HOME/.t3/userdata/settings.json"

mkdir -p "$HOME/factory-skills/triage"
echo "# Triage" > "$HOME/factory-skills/triage/SKILL.md"

echo "== install"
printf '%s\n' "$password" | $cli install --port "$port" --skill "$HOME/factory-skills/triage"
test -d "$HOME/.hephaestus" || fail "~/.hephaestus missing"
test "$(stat -c %a "$HOME/.hephaestus")" = 700 || fail "~/.hephaestus is not mode 700"
ls -la "$HOME/.hephaestus"
cat "$unit"
for file in .hermes/config.yaml .hermes/profiles/work/config.yaml .claude/CLAUDE.md \
  .claude/skills/review/SKILL.md .codex/config.toml .t3/userdata/settings.json; do
  grep -q "\"$file\": \"$(hash_of "$HOME/$file")\"" "$HOME/.hephaestus/baseline.json" \
    || fail "baseline has no correct hash for $file"
done
if grep -q "$password" "$HOME/.hephaestus/state.db"; then fail "password stored in plain text"; fi
test "$(systemctl --user is-active hephaestus.service)" = active || fail "service not active"
test "$(systemctl --user is-enabled hephaestus.service)" = enabled || fail "service not enabled"
wait_for_dashboard

echo "== reinstall is refused"
run sh -c "printf '%s\n' '$password' | $cli install --port $port"
test "$code" != 0 || fail "second install succeeded"

echo "== no session"
test "$(status "$base/")" = 303 || fail "/ without a session did not redirect"
test "$(status "$base/api/session")" = 401 || fail "/api/session without a session was not 401"
test "$(status --header 'cookie: hephaestus_session=forged' "$base/api/session")" = 401 \
  || fail "forged cookie accepted"

echo "== login"
test "$(status --data-urlencode 'password=wrong horse battery' "$base/login")" = 401 \
  || fail "wrong password accepted"
headers=$(curl --silent --output /dev/null --dump-header - --data-urlencode "password=$password" "$base/login")
echo "$headers" | sed -n 's/^\([Ss]et-[Cc]ookie: hephaestus_session=\)[^;]*/\1<redacted>/p'
cookie=$(echo "$headers" | sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*\);.*/\1/p')
test -n "$cookie" || fail "login set no cookie"
test "$(status --header "cookie: $cookie" "$base/")" = 200 || fail "/ with a session was not 200"
test "$(status --header "cookie: $cookie" "$base/api/session")" = 200 \
  || fail "/api/session with a session was not 200"

echo "== config"
versions=$(curl --silent --header "cookie: $cookie" "$base/config/versions")
echo "$versions" | grep -q 'href="/config/versions/1"' || fail "config does not list version 1"
curl --silent --header "cookie: $cookie" "$base/api/config/versions/1" | grep -q '"triage"' \
  || fail "first version lacks the imported skill"
test "$(status "$base/config")" = 303 || fail "/config without a session did not redirect"
test "$(status "$base/api/config/versions")" = 401 || fail "/api/config/versions without a session was not 401"

echo "== workers (no T3 in this container)"
test "$(status --header "cookie: $cookie" "$base/workers")" = 502 || fail "/workers did not report T3 unreachable"
curl --silent --header "cookie: $cookie" "$base/" | grep -q "T3 could not be reached" || fail "overview did not say T3 is unreachable"
test "$(status "$base/api/environments")" = 401 || fail "/api/environments without a session was not 401"

echo "== the session survives a service restart"
systemctl --user restart hephaestus.service
wait_for_dashboard
test "$(status --header "cookie: $cookie" "$base/api/session")" = 200 || fail "session lost on restart"

echo "== uninstall reports changed owner files, including inside a linked skill"
echo "# edited" > "$HOME/.claude/CLAUDE.md"
echo "# review v2" > "$HOME/skills-checkout/review/SKILL.md"
set +e
report=$($cli uninstall)
code=$?
set -e
echo "$report"
test "$code" = 2 || fail "uninstall exit code was $code, expected 2"
echo "$report" | grep -q '\.claude/CLAUDE\.md' || fail "uninstall did not report CLAUDE.md"
echo "$report" | grep -q '\.claude/skills/review/SKILL\.md' || fail "uninstall did not report the linked skill"
report=$($cli uninstall 2>&1 || true)
echo "$report" | grep -q "No Hephaestus install found" || fail "second uninstall did not say nothing is installed"
test ! -e "$HOME/.hephaestus" || fail "~/.hephaestus still exists"
test ! -e "$unit" || fail "unit file still exists"
if systemctl --user is-active hephaestus.service >/dev/null 2>&1; then fail "service still active"; fi
if curl --silent --output /dev/null "$base/login"; then fail "dashboard still answers"; fi

echo "== the drift report names exactly the changed files"
printf '%s\n' "$password" | $cli install --port "$port"
wait_for_dashboard
echo "# edited again" > "$HOME/.claude/CLAUDE.md"
report=$($cli uninstall || true)
echo "$report"
echo "$report" | grep -q '\.claude/CLAUDE\.md' || fail "uninstall did not report the changed file"
for file in .hermes/config.yaml .hermes/profiles/work/config.yaml .codex/config.toml .t3/userdata/settings.json; do
  if echo "$report" | grep -qF "$file"; then fail "uninstall reported unchanged $file"; fi
done

echo "== install and uninstall with no changes"
printf '%s\n' "$password" | $cli install --port "$port"
wait_for_dashboard
run $cli uninstall
test "$code" = 0 || fail "clean uninstall exit code was $code, expected 0"
test ! -e "$HOME/.hephaestus" || fail "~/.hephaestus still exists"

echo "== uninstall removes the recorded unit even when XDG_CONFIG_HOME changed"
printf '%s\n' "$password" | $cli install --port "$port"
wait_for_dashboard
run env XDG_CONFIG_HOME="$HOME/elsewhere" $cli uninstall
test "$code" = 0 || fail "uninstall with another XDG_CONFIG_HOME exited $code"
test ! -e "$unit" || fail "recorded unit file still exists"
if systemctl --user is-active hephaestus.service >/dev/null 2>&1; then fail "service still active"; fi

echo "== install fails and rolls back when another program holds the port"
node -e 'require("node:http").createServer((q, s) => s.end("other")).listen(7701, "0.0.0.0")' &
other=$!
sleep 1
run sh -c "printf '%s\n' '$password' | $cli install --port 7701"
kill "$other"
test "$code" != 0 || fail "install succeeded on a busy port"
test ! -e "$HOME/.hephaestus" || fail "~/.hephaestus left behind after a failed install"
test ! -e "$unit" || fail "unit file left behind after a failed install"

echo "== an existing unit file is refused and kept"
mkdir -p "$(dirname "$unit")"
printf '[Unit]\nDescription=the owner'"'"'s own unit\n' > "$unit"
run sh -c "printf '%s\n' '$password' | $cli install --port $port"
test "$code" != 0 || fail "install replaced an existing unit"
grep -q "the owner's own unit" "$unit" || fail "existing unit was changed"
test ! -e "$HOME/.hephaestus" || fail "~/.hephaestus left behind"
rm "$unit"

echo "== install works from a path with spaces"
cp -r /opt/hephaestus "$HOME/Factory Tools"
printf '%s\n' "$password" | node "$HOME/Factory Tools/dist/cli.js" install --port "$port"
wait_for_dashboard
test "$(systemctl --user is-active hephaestus.service)" = active || fail "service not active"
run node "$HOME/Factory Tools/dist/cli.js" uninstall
test "$code" = 0 || fail "uninstall from a path with spaces exited $code"

echo "== update: a checkout with an origin, installed from"
co="$HOME/checkout"
origin="$HOME/origin.git"
work="$HOME/work"
mkdir -p "$co"
for part in package.json package-lock.json tsconfig.json tsconfig.build.json src templates assets; do
  cp -r "/opt/hephaestus/$part" "$co/"
done
printf 'node_modules/\ndist/\n' > "$co/.gitignore"
commit() {
  git -C "$1" add -A
  git -C "$1" -c user.name=test -c user.email=test@example.com commit --quiet --allow-empty -m "$2"
}
git -C "$co" init --quiet --initial-branch=main
commit "$co" "first"
git clone --quiet --bare "$co" "$origin"
git -C "$co" remote add origin "$origin"
git -C "$co" fetch --quiet origin
(cd "$co" && npm ci --silent && npm run build --silent)
git clone --quiet "$origin" "$work"
# Pushes a commit to origin from another clone, as a merged PR would arrive.
push() {
  sh -c "$2" "$work"
  commit "$work" "$1"
  git -C "$work" push --quiet origin main
}
main_pid() {
  systemctl --user show -P MainPID hephaestus.service
}
update() {
  set +e
  out=$(node "$co/dist/cli.js" update 2>&1)
  code=$?
  set -e
  echo "$out"
}
printf '%s\n' "$password" | node "$co/dist/cli.js" install --port "$port"
wait_for_dashboard
first=$(git -C "$co" rev-parse HEAD)
push "add a marker" 'echo "export const MARK = 1;" > "$0/src/mark.ts"'

echo "== update refuses uncommitted changes and changes nothing"
pid=$(main_pid)
echo "// edited" >> "$co/src/update.ts"
update
test "$code" != 0 || fail "update ran with uncommitted changes"
echo "$out" | grep -q "uncommitted changes" || fail "update did not name the uncommitted changes"
test "$(git -C "$co" rev-parse HEAD)" = "$first" || fail "update moved a dirty checkout"
test "$(main_pid)" = "$pid" || fail "update restarted the service after refusing"
git -C "$co" checkout -- src/update.ts

echo "== update refuses a checkout that cannot fast-forward"
commit "$co" "a local commit"
update
test "$code" != 0 || fail "update ran on a diverged checkout"
echo "$out" | grep -q "cannot fast-forward" || fail "update did not say it cannot fast-forward"
test "$(main_pid)" = "$pid" || fail "update restarted the service after refusing"
git -C "$co" reset --quiet --hard "$first"

echo "== update fast-forwards, installs, builds, and restarts the service"
update
test "$code" = 0 || fail "update exited $code"
test "$(git -C "$co" rev-parse HEAD)" = "$(git -C "$origin" rev-parse main)" \
  || fail "the checkout is not at origin/main"
test -f "$co/dist/mark.js" || fail "the new commit was not built"
test "$(main_pid)" != "$pid" || fail "the service was not restarted"
test "$(systemctl --user is-active hephaestus.service)" = active || fail "service not active"
wait_for_dashboard

echo "== a build that fails is rolled back, and the old build keeps running"
pid=$(main_pid)
built=$(git -C "$co" rev-parse HEAD)
push "break the build" 'echo "export const BROKEN: number = \"text\";" > "$0/src/broken.ts"'
update
test "$code" != 0 || fail "update succeeded on a broken build"
echo "$out" | grep -q "did not restart" || fail "update did not say it left the service running"
echo "$out" | grep -q "rolled back" || fail "update did not say it rolled back"
test "$(git -C "$co" rev-parse HEAD)" = "$built" || fail "the checkout was not rolled back"
test "$(main_pid)" = "$pid" || fail "update restarted the service on a broken build"
test "$(systemctl --user is-active hephaestus.service)" = active || fail "service not active"
# The old build on disk still starts, so a restart or reboot is safe.
systemctl --user restart hephaestus.service
wait_for_dashboard
run node "$co/dist/cli.js" uninstall
test ! -e "$HOME/.hephaestus" || fail "~/.hephaestus still exists"

echo "PASS"
