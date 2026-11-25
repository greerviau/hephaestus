#!/bin/sh
# Removes a test container started by up.sh.
# Usage: test/container/down.sh <name>
set -eu

docker rm --force "$1" >/dev/null
