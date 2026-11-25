#!/bin/sh
# Launches a container, runs the install, login and uninstall journey as the
# owner, saves the transcript as evidence, and removes the container.
set -eu

root=$(cd "$(dirname "$0")/../../../.." && pwd)
evidence="${HEPHAESTUS_VERIFY_EVIDENCE:-$HOME/.cache/hephaestus-verify}/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p -m 700 "$evidence"

name=$("$root/test/container/up.sh")
trap '"$root/test/container/down.sh" "$name"' EXIT
echo "container: $name" > "$evidence/run.txt"
git -C "$root" rev-parse HEAD >> "$evidence/run.txt"

status=0
"$root/test/container/as-owner.sh" "$name" sh -x /usr/local/bin/scenario.sh > "$evidence/journey.log" 2>&1 || status=$?
# The shell trace prints session cookies; keep them out of the evidence.
sed -i -E 's/(hephaestus_session=)[A-Za-z0-9_-]{16,}/\1<redacted>/g' "$evidence/journey.log"
chmod 600 "$evidence/journey.log" "$evidence/run.txt"
echo "exit: $status" >> "$evidence/run.txt"
echo "$evidence"
exit "$status"
