#!/bin/sh
# Removes a test container started by up.sh and the image tag it built.
# Usage: test/container/down.sh <name>
set -eu

tag=$(docker inspect --format '{{ index .Config.Labels "hephaestus.test-image" }}' "$1" 2>/dev/null || true)
docker rm --force "$1" >/dev/null
if [ -n "$tag" ]; then
  docker rmi "$tag" >/dev/null 2>&1 || true
fi
