#!/usr/bin/env bash
# List contestant runs that are not yet collected: elapsed vs limit and agent state.
# Prints: <run-id> <state> <elapsed>m/<limit>m [OVER]
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
CONTEST_LOG=${CONTEST_LOG:-$REPO/.orchestra/runs.tsv}
[ -f "$CONTEST_LOG" ] || exit 0
now=$(date +%s)
while IFS=$'\t' read -r rid label agent term dir start limit; do
  [ -f "$REPO/results/$rid.json" ] && continue
  raw=$(hc get "$term" 2>/dev/null)
  if [ -z "$raw" ]; then st=gone
  else st=$(echo "$raw" | grep -o '"status":{[^}]*}' | grep -o '"state":"[a-z]*"' | head -1 | cut -d'"' -f4); st=${st:-live}; fi
  el=$(( (now - start) / 60 ))
  over=""; [ "$el" -ge "$limit" ] && over=" OVER"
  echo "$rid $st ${el}m/${limit}m$over"
done < "$CONTEST_LOG"
