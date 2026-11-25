#!/bin/sh
# Launches a container, runs the install, login and uninstall journey as the
# owner, saves the transcript as evidence, and removes the container.
set -eu

root=$(cd "$(dirname "$0")/../../../.." && pwd)
evidence="${HEPHAESTUS_VERIFY_EVIDENCE:-$HOME/.cache/hephaestus-verify}/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$evidence"

name=$("$root/test/container/up.sh")
trap '"$root/test/container/down.sh" "$name"' EXIT
echo "container: $name" > "$evidence/run.txt"
git -C "$root" rev-parse HEAD >> "$evidence/run.txt"

status=0
"$root/test/container/as-owner.sh" "$name" sh -x /usr/local/bin/scenario.sh > "$evidence/journey.log" 2>&1 || status=$?
echo "exit: $status" >> "$evidence/run.txt"
echo "$evidence"
exit "$status"
