#!/bin/sh
# Builds an image from the checkout under a tag of its own, boots systemd in a
# new container from it, starts a user manager for the `owner` user, and
# prints the container name. On any failure it removes what it created.
# Usage: test/container/up.sh [name]
set -eu

name=${1:-hephaestus-test-$$}
tag="hephaestus-test:$name"
root=$(cd "$(dirname "$0")/../.." && pwd)

docker build --quiet --tag "$tag" --file "$root/test/container/Dockerfile" "$root" >/dev/null

ready=no
cleanup() {
  if [ "$ready" != yes ]; then
    docker rm --force "$name" >/dev/null 2>&1 || true
    docker rmi "$tag" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker run --detach --name "$name" --label "hephaestus.test-image=$tag" \
  --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock "$tag" >/dev/null

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
    exit 1
    ;;
esac

docker exec "$name" loginctl enable-linger owner
uid=$(docker exec "$name" id -u owner)
for _ in $(seq 1 30); do
  docker exec "$name" test -S "/run/user/$uid/bus" && break
  sleep 1
done
if ! docker exec "$name" test -S "/run/user/$uid/bus"; then
  echo "user manager for owner did not start" >&2
  exit 1
fi

ready=yes
echo "$name"
