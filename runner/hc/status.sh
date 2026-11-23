#!/usr/bin/env bash
# List contestant runs that are not yet collected: elapsed vs limit and agent state.
# Prints: <run-id> <state> <elapsed>m/<limit>m [OVER]
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
CONTEST_LOG=${CONTEST_LOG:-$REPO/.orchestra/runs.tsv}
AWAKE_FILE=${AWAKE_FILE:-$REPO/.orchestra/awake.tsv}
RESULTS_DIR=${RESULTS_DIR:-$REPO/results}
HC_BIN=${HC_BIN:-hc}
[ -f "$CONTEST_LOG" ] || exit 0
while IFS=$'\t' read -r rid term el limit over; do
  [ -z "$rid" ] && continue
  raw=$("$HC_BIN" get "$term" 2>/dev/null)
  if [ -z "$raw" ]; then st=gone
  else st=$(echo "$raw" | grep -o '"status":{[^}]*}' | grep -o '"state":"[a-z]*"' | head -1 | cut -d'"' -f4); st=${st:-live}; fi
  echo "$rid $st ${el}m/${limit}m${over:+ $over}"
done < <(node "$REPO/runner/collect.mjs" --status-rows --runs-tsv "$CONTEST_LOG" --awake-file "$AWAKE_FILE" --results-dir "$RESULTS_DIR")
