#!/bin/sh
# Builds the test image, boots systemd in a new container, starts a user
# manager for the `owner` user, and prints the container name.
# Usage: test/container/up.sh [name]
set -eu

image=hephaestus-container-test
name=${1:-hephaestus-test-$$}
root=$(cd "$(dirname "$0")/../.." && pwd)

docker build --quiet --file "$root/test/container/Dockerfile" --tag "$image" "$root" >&2
docker run --detach --name "$name" --privileged --cgroupns=private \
  --tmpfs /run --tmpfs /run/lock "$image" >/dev/null

state=unknown
for _ in $(seq 1 60); do
  state=$(docker exec "$name" systemctl is-system-running 2>/dev/null || true)
  case "$state" in running | degraded) break ;; esac
  sleep 1
done
case "$state" in
  running | degraded) ;;
  *)
    echo "systemd did not boot: $state" >&2
    docker rm --force "$name" >/dev/null
    exit 1
    ;;
esac

docker exec "$name" loginctl enable-linger owner
uid=$(docker exec "$name" id -u owner)
for _ in $(seq 1 30); do
  docker exec "$name" test -S "/run/user/$uid/bus" && break
  sleep 1
done
docker exec "$name" test -S "/run/user/$uid/bus" || {
  echo "user manager for owner did not start" >&2
  docker rm --force "$name" >/dev/null
  exit 1
}

echo "$name"
