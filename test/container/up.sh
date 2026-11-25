#!/bin/sh
# Builds an image from the checkout, boots systemd in a new container from
# that exact image, starts a user manager for the `owner` user, and prints the
# container name.
# Usage: test/container/up.sh [name]
set -eu

name=${1:-hephaestus-test-$$}
root=$(cd "$(dirname "$0")/../.." && pwd)
iidfile=$(mktemp)
trap 'rm -f "$iidfile"' EXIT

docker build --quiet --iidfile "$iidfile" --file "$root/test/container/Dockerfile" "$root" >/dev/null
image=$(cat "$iidfile")
docker run --detach --name "$name" --label "hephaestus.test-image=$image" \
  --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock "$image" >/dev/null

fail() {
  echo "$*" >&2
  "$root/test/container/down.sh" "$name"
  exit 1
}

state=unknown
for _ in $(seq 1 60); do
  state=$(docker exec "$name" systemctl is-system-running 2>/dev/null || true)
  case "$state" in running | degraded) break ;; esac
  sleep 1
done
case "$state" in running | degraded) ;; *) fail "systemd did not boot: $state" ;; esac

docker exec "$name" loginctl enable-linger owner
uid=$(docker exec "$name" id -u owner)
for _ in $(seq 1 30); do
  docker exec "$name" test -S "/run/user/$uid/bus" && break
  sleep 1
done
docker exec "$name" test -S "/run/user/$uid/bus" || fail "user manager for owner did not start"

echo "$name"
