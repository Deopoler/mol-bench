#!/usr/bin/env bash
# Finish one contestant run: stop its terminal, grade with hidden data, record results.
# usage: runner/hc/collect.sh <run-id> [--timeout]
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
rid=$1; flag=${2:-}
CONTEST_LOG=${CONTEST_LOG:-$REPO/.orchestra/runs.tsv}
line=$(grep -P "^\Q$rid\E\t" "$CONTEST_LOG" | tail -1)
label=$(echo "$line" | cut -f2); term=$(echo "$line" | cut -f4)
[ "$flag" = "--timeout" ] && hc interrupt "$term" >/dev/null 2>&1 || true
hc kill "$term" >/dev/null 2>&1 || true
hc rm "$term" >/dev/null 2>&1 || true
cd "$REPO"
node runner/collect.mjs "$rid" --model "$label" ${flag:+--timed-out} 2>&1 | tail -3
