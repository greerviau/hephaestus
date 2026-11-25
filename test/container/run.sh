#!/bin/sh
# Runs the install, login and uninstall scenario in a fresh systemd container.
set -eu

dir=$(cd "$(dirname "$0")" && pwd)
name=$("$dir/up.sh")
trap '"$dir/down.sh" "$name"' EXIT

"$dir/as-owner.sh" "$name" sh /usr/local/bin/scenario.sh
