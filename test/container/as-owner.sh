#!/bin/sh
# Runs a command in the test container as `owner`, with that user's systemd
# user manager reachable.
# Usage: test/container/as-owner.sh <name> <command> [args...]
set -eu

name=$1
shift
uid=$(docker exec "$name" id -u owner)
exec docker exec --interactive --user owner --workdir /home/owner \
  --env "XDG_RUNTIME_DIR=/run/user/$uid" \
  --env "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus" \
  "$name" "$@"
