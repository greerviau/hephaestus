#!/bin/sh
# Prints one hash over the files the container image is built from, so a
# running container can be matched to a checkout.
# Usage: test/container/source-hash.sh [root]
set -eu

cd "${1:-$(dirname "$0")/../..}"
find package.json package-lock.json tsconfig.json tsconfig.build.json src templates -type f \
  | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1
