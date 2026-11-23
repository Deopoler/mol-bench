#!/usr/bin/env bash
# Finish one contestant run: stop its terminal, grade with hidden data, record results.
# usage: runner/hc/collect.sh <run-id> [--timeout]
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
rid=$1; flag=${2:-}
CONTEST_LOG=${CONTEST_LOG:-$REPO/.orchestra/runs.tsv}
AWAKE_FILE=${AWAKE_FILE:-$REPO/.orchestra/awake.tsv}
RESULTS_DIR=${RESULTS_DIR:-$REPO/results}
HC_BIN=${HC_BIN:-hc}
COLLECT_MAX_RETRIES=${COLLECT_MAX_RETRIES:-3}
line=$(awk -F'\t' -v r="$rid" '$1==r' "$CONTEST_LOG" | tail -1 || true)
label=$(echo "$line" | cut -f2); term=$(echo "$line" | cut -f4)
[ "$flag" = "--timeout" ] && "$HC_BIN" interrupt "$term" >/dev/null 2>&1 || true
"$HC_BIN" kill "$term" >/dev/null 2>&1 || true
"$HC_BIN" rm "$term" >/dev/null 2>&1 || true
cd "$REPO"
n=0; [ -f .orchestra/interventions.tsv ] && n=$(awk -F'	' -v r="$rid" '$1==r && $2 !~ /^approve/' .orchestra/interventions.tsv | wc -l)
rc=0
node runner/collect.mjs "$rid" --model "$label" --results-dir "$RESULTS_DIR" ${flag:+--timed-out} --interventions "$n" 2>&1 | tail -3 || rc=$?
term_state="collected"
[ "$flag" = "--timeout" ] && term_state="timed-out"
node runner/collect.mjs --ensure-terminal-result "$rid" --label "$label" --runs-tsv "$CONTEST_LOG" --awake-file "$AWAKE_FILE" --results-dir "$RESULTS_DIR" --state "$term_state" --max-retries "$COLLECT_MAX_RETRIES" --reason "collect.mjs exited with status $rc" >/dev/null 2>&1 || true
exit "$rc"
