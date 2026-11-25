#!/bin/sh
# Removes a test container started by up.sh, and its image unless another
# container still uses it.
# Usage: test/container/down.sh <name>
set -eu

image=$(docker inspect --format '{{ index .Config.Labels "hephaestus.test-image" }}' "$1" 2>/dev/null || true)
docker rm --force "$1" >/dev/null
if [ -n "$image" ]; then
  docker rmi "$image" >/dev/null 2>&1 || true
fi
