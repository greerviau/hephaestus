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

# Stand-in personal config that install must record and uninstall must check.
mkdir -p "$HOME/.hermes" "$HOME/.claude/skills/review" "$HOME/.codex" "$HOME/.t3/userdata"
echo "model: personal" > "$HOME/.hermes/config.yaml"
echo "# personal" > "$HOME/.claude/CLAUDE.md"
echo "# review" > "$HOME/.claude/skills/review/SKILL.md"
echo "model = 'personal'" > "$HOME/.codex/config.toml"
echo "{}" > "$HOME/.t3/userdata/settings.json"

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

echo "== install"
printf '%s\n' "$password" | $cli install --port "$port"
test -d "$HOME/.hephaestus" || fail "~/.hephaestus missing"
test "$(stat -c %a "$HOME/.hephaestus")" = 700 || fail "~/.hephaestus is not mode 700"
grep -q '"sha256:' "$HOME/.hephaestus/baseline.json" || fail "baseline has no hashes"
grep -q "$password" "$HOME/.hephaestus/state.db" && fail "password stored in plain text"
test "$(systemctl --user is-active hephaestus.service)" = active || fail "service not active"
test "$(systemctl --user is-enabled hephaestus.service)" = enabled || fail "service not enabled"
wait_for_dashboard

echo "== reinstall is refused"
if printf '%s\n' "$password" | $cli install --port "$port" 2>/dev/null; then fail "second install succeeded"; fi

echo "== no session"
test "$(status "$base/")" = 303 || fail "/ without a session did not redirect"
test "$(status "$base/api/session")" = 401 || fail "/api/session without a session was not 401"
test "$(status --header 'cookie: hephaestus_session=forged' "$base/api/session")" = 401 || fail "forged cookie accepted"

echo "== login"
test "$(status --data-urlencode 'password=wrong horse battery' "$base/login")" = 401 || fail "wrong password accepted"
cookie=$(curl --silent --output /dev/null --dump-header - --data-urlencode "password=$password" "$base/login" \
  | sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*\);.*/\1/p')
test -n "$cookie" || fail "login set no cookie"
test "$(status --header "cookie: $cookie" "$base/")" = 200 || fail "/ with a session was not 200"
test "$(status --header "cookie: $cookie" "$base/api/session")" = 200 || fail "/api/session with a session was not 200"

echo "== the session survives a service restart"
systemctl --user restart hephaestus.service
wait_for_dashboard
test "$(status --header "cookie: $cookie" "$base/api/session")" = 200 || fail "session lost on restart"

echo "== uninstall with a changed owner file"
echo "# edited" > "$HOME/.claude/CLAUDE.md"
set +e
report=$($cli uninstall)
code=$?
set -e
echo "$report"
test "$code" = 2 || fail "uninstall exit code was $code, expected 2"
echo "$report" | grep -q '.claude/CLAUDE.md' || fail "uninstall did not report the changed file"
echo "$report" | grep -q '.hermes/config.yaml' && fail "uninstall reported an unchanged file"
test ! -e "$HOME/.hephaestus" || fail "~/.hephaestus still exists"
test ! -e "$unit" || fail "unit file still exists"
systemctl --user is-active hephaestus.service >/dev/null 2>&1 && fail "service still active"
curl --silent --output /dev/null "$base/login" && fail "dashboard still answers"

echo "== install and uninstall with no changes"
printf '%s\n' "$password" | $cli install --port "$port"
wait_for_dashboard
$cli uninstall | grep -q "unchanged since install" || fail "clean uninstall reported changes"
test ! -e "$HOME/.hephaestus" || fail "~/.hephaestus still exists"

echo "PASS"
