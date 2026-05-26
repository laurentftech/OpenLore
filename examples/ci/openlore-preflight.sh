#!/usr/bin/env sh
# OpenLore preflight — generic shell snippet usable from any CI system
# (CircleCI, Buildkite, Jenkins, your laptop). Set BASE_REF to whatever
# branch this change should be compared against.
#
# Exit codes: 0 = fresh, 1 = stale, 2 = error.

set -eu

BASE_REF="${BASE_REF:-origin/main}"

# Make sure the ref actually exists locally — shallow clones / CI runners
# often need an explicit fetch.
git fetch --no-tags --depth=0 origin "$(basename "$BASE_REF")" >/dev/null 2>&1 || true

exec npx --yes openlore preflight --since "$BASE_REF" "$@"
