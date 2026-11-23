#!/usr/bin/env bash
# Unattended contest scheduler (runs inside an hc terminal, uses no LLM tokens itself).
#   hc run --bg --name autopilot --cwd <repo> -- bash runner/hc/autopilot.sh
# Queue file (.orchestra/queue.tsv), one job per line, tab-separated:
#   agent  model  effort  label  room  renovation(or -)  quota-key  need%
# quota-key is what ~/.claude/orchestra/quota.py understands ("Gemini 4 Neon (High)", "cc:opus", "codex").
# A job starts only when every window of its quota group has >= need% remaining.
# Each loop: collect finished/over-limit runs, deny out-of-folder permission prompts (logged as interventions),
# launch queued jobs up to MAXPAR, regenerate leaderboard/gallery, commit and push results.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"
QUEUE=${QUEUE:-$REPO/.orchestra/queue.tsv}
CONTEST_LOG=${CONTEST_LOG:-$REPO/.orchestra/runs.tsv}
AWAKE_FILE=${AWAKE_FILE:-$REPO/.orchestra/awake.tsv}
RESULTS_DIR=${RESULTS_DIR:-$REPO/results}
LOG=${LOG:-$REPO/.orchestra/autopilot.log}
MAXPAR=${MAXPAR:-3}
INTERVAL=${INTERVAL:-300}
IDLE_TICKS=${IDLE_TICKS:-2}
GONE_TICKS=${GONE_TICKS:-3}
COLLECT_MAX_RETRIES=${COLLECT_MAX_RETRIES:-3}
QUOTA=${QUOTA:-$HOME/.claude/orchestra/quota.py}
HC_BIN=${HC_BIN:-hc}
AUTOPILOT_ONCE=${AUTOPILOT_ONCE:-0}
export AGY_BIN=${AGY_BIN:-agy} CODEX_BIN=${CODEX_BIN:-codex}
log() { echo "[$(date '+%m-%d %H:%M')] $*" | tee -a "$LOG"; }

summary() {
  python - "$RESULTS_DIR/$1.json" "$1" 2>/dev/null <<'PY' || echo "$1 (no result)"
import json, sys
d = json.load(open(sys.argv[1]))
if d.get('status') in ('no-submission', 'collect-error') or d.get('composite') is None:
  print('%s status=%s (%s)' % (sys.argv[2], d.get('status') or 'unranked', d.get('reason') or 'no composite'))
else:
  ax = d.get('axes', {})
  g = [k for k, v in d.get('gates', {}).items() if v.get('pass') is False]
  eff = d.get('efficiency', {})
  t = eff.get('active_min') if eff.get('active_min') is not None else eff.get('wall_min')
  print('%s composite=%.2f %s active=%.1fm %s' % (
    sys.argv[2],
    d.get('composite') or 0,
    ' '.join('%s=%.2f' % (k, v) for k, v in ax.items() if v is not None),
    t or 0,
    ('FAILGATES=' + ','.join(g)) if g else ''
  ))
PY
}

publish() {
  node harness/src/leaderboard.mjs --results "$RESULTS_DIR" >/dev/null 2>&1 || log "leaderboard failed"
  [ -f harness/src/gallery.mjs ] && { node harness/src/gallery.mjs --results "$RESULTS_DIR" >/dev/null 2>&1 || log "gallery failed"; }
  rel_results=$(node -e "const p=require('path'); const r=p.relative(process.cwd(), p.resolve(process.argv[1])).replace(/\\\\/g,'/'); console.log(r && !r.startsWith('..') && !p.isAbsolute(r) ? r : '');" "$RESULTS_DIR" 2>/dev/null || true)
  if [ -z "$rel_results" ]; then
    return 0
  fi
  rel_results_re=$(printf '%s' "$rel_results" | sed 's/[.[\\*^$+?(){}|]/\\&/g')
  real_changes=$(git status --porcelain -- "$rel_results/*.json" "$rel_results/submissions" 2>/dev/null | grep -cvE "^.. \"?${rel_results_re}/(leaderboard|data)\\.json\"?$" || true)
  if [ "${real_changes:-0}" -eq 0 ]; then
    return 0
  fi
  git add -- "$rel_results" site >/dev/null 2>&1
  if ! git diff --cached --quiet; then
    git commit -qm "results: autopilot update $(date '+%m-%d %H:%M')" && (git push -q >/dev/null 2>&1 || log "push failed")
  fi
}

run_collect() {
  local rid="$1" flag="$2" prefix="$3" rc=0
  CONTEST_LOG="$CONTEST_LOG" AWAKE_FILE="$AWAKE_FILE" RESULTS_DIR="$RESULTS_DIR" HC_BIN="$HC_BIN" COLLECT_MAX_RETRIES="$COLLECT_MAX_RETRIES" bash runner/hc/collect.sh "$rid" $flag >/dev/null 2>&1 || rc=$?
  if [ -f "$RESULTS_DIR/$rid.json" ]; then
    log "${prefix}: $(summary "$rid")"; changed=1
  else
    log "$rid: collection failed (rc=$rc), queued for retry"
  fi
}

while true; do
  changed=0
  awake_since_launch=$(node runner/collect.mjs --awake-tick --runs-tsv "$CONTEST_LOG" --awake-file "$AWAKE_FILE" --results-dir "$RESULTS_DIR" --interval "$INTERVAL" ${NOW_EPOCH:+--now "$NOW_EPOCH"} --print-since-launch 2>/dev/null || echo 0)

  # 1) collect finished or over-limit runs; handle permission prompts
  while read -r rid state elapsed over; do
    [ -z "$rid" ] && continue
    line=$(awk -F'\t' -v r="$rid" '$1==r' "$CONTEST_LOG" | tail -1 || true)
    term=$(printf '%s\n' "$line" | cut -f4); dir=$(printf '%s\n' "$line" | cut -f5)
    if [ "$state" = blocked ]; then
      screen=$("$HC_BIN" read --lines 25 "$term" 2>/dev/null)
      if echo "$screen" | grep -q "No, cancel"; then
        "$HC_BIN" keys "$term" down down down enter >/dev/null 2>&1; sleep 3
        "$HC_BIN" send "$term" "[harness] That command was denied by the benchmark harness (only actions inside this folder are allowed). Continue the task without it." >/dev/null 2>&1
        printf '%s\tdeny+continue\t%s\n' "$rid" "$(echo "$screen" | grep -A1 'Requesting permission' | tail -1 | tr -s ' ' | cut -c1-160)" >> .orchestra/interventions.tsv
        log "$rid: denied a permission prompt (intervention logged)"
      fi
    fi
    [ "$state" = error ] && log "$rid ended in ERROR state ($("$HC_BIN" get "$term" 2>/dev/null | grep -o '"msg":"[^"]*"' | head -1))"
    mode=$(node runner/collect.mjs --check-collect "$rid" --state "$state" --over "${over:-}" --run-dir "$dir" --awake-file "$AWAKE_FILE" --idle-ticks "$IDLE_TICKS" --gone-ticks "$GONE_TICKS" 2>/dev/null || echo skip)
    case "$mode" in
      normal)  run_collect "$rid" "" "collected" ;;
      timeout) run_collect "$rid" "--timeout" "timeout-collected" ;;
    esac
  done < <(CONTEST_LOG="$CONTEST_LOG" AWAKE_FILE="$AWAKE_FILE" RESULTS_DIR="$RESULTS_DIR" HC_BIN="$HC_BIN" bash runner/hc/status.sh | sed 's# \([0-9]*\)m/[0-9]*m# \1#')

  # 2) launch queued jobs while capacity and quota allow
  running=$(CONTEST_LOG="$CONTEST_LOG" AWAKE_FILE="$AWAKE_FILE" RESULTS_DIR="$RESULTS_DIR" HC_BIN="$HC_BIN" bash runner/hc/status.sh | wc -l)
  if [ -f "$QUEUE" ] && [ "$running" -lt "$MAXPAR" ]; then
    : > "$QUEUE.next"
    while IFS=$'\t' read -r agent model effort label room rev qkey need; do
      [ -z "${agent:-}" ] && continue
      case "$agent" in \#*) echo -e "$agent\t$model\t$effort\t$label\t$room\t$rev\t$qkey\t$need" >> "$QUEUE.next"; continue ;; esac
      if [ "$running" -lt "$MAXPAR" ] && python "$QUOTA" "$qkey" --need "$need" >/dev/null 2>&1; then
        [ "$rev" = "-" ] && rev=""
        out=$(CONTEST_LOG="$CONTEST_LOG" bash runner/hc/contest.sh "$agent" "$model" "$effort" "$label" "$room" $rev 2>&1 | tail -1)
        launched_rid=$(echo "$out" | awk '{print $1}')
        node runner/collect.mjs --awake-launch "$launched_rid" --awake-file "$AWAKE_FILE" ${NOW_EPOCH:+--now "$NOW_EPOCH"} >/dev/null 2>&1 || true
        log "launched: $label on $room${rev:+-$rev} -> $out"; running=$((running + 1)); awake_since_launch=0
      else
        echo -e "$agent\t$model\t$effort\t$label\t$room\t$rev\t$qkey\t$need" >> "$QUEUE.next"
      fi
    done < "$QUEUE"
    mv "$QUEUE.next" "$QUEUE"
  fi

  [ "$changed" = 1 ] && publish

  # Record end-of-iteration heartbeat so long active steps (grading/collecting) count in full as awake time.
  awake_since_launch=$(node runner/collect.mjs --awake-heartbeat --runs-tsv "$CONTEST_LOG" --awake-file "$AWAKE_FILE" --results-dir "$RESULTS_DIR" ${NOW_EPOCH:+--now "$NOW_EPOCH"} --print-since-launch 2>/dev/null || echo "${awake_since_launch:-0}")

  # 3) optional: put the machine to sleep when there is nothing left to do.
  #    Done = no running runs AND (no active queue jobs OR nothing could launch for STUCK_HOURS of awake time after NOT_BEFORE).
  if [ "${SLEEP_WHEN_DONE:-0}" = 1 ]; then
    running=$(CONTEST_LOG="$CONTEST_LOG" AWAKE_FILE="$AWAKE_FILE" RESULTS_DIR="$RESULTS_DIR" HC_BIN="$HC_BIN" bash runner/hc/status.sh | wc -l)
    active=$(grep -cvE '^(#|[[:space:]]*$)' "$QUEUE" 2>/dev/null) || active=0
    now=${NOW_EPOCH:-$(date +%s)}; not_before=${NOT_BEFORE_EPOCH:-0}; stuck=$(( ${STUCK_HOURS:-4} * 3600 ))
    if [ "$running" -eq 0 ] && [ "$now" -ge "$not_before" ] && { [ "$active" -eq 0 ] || [ "${awake_since_launch:-0}" -ge "$stuck" ]; }; then
      if [ "${REGRADE_BEFORE_SLEEP:-0}" = 1 ]; then
        log "final regrade of all runs (current harness/specs)"
        runs_root=${MOLBENCH_RUNS:-$HOME/molbench-runs}
        for f in "$RESULTS_DIR"/*.json; do
          [ -f "$f" ] || continue
          rid=$(basename "$f" .json); [ "$rid" = leaderboard ] && continue
          [ -d "$runs_root/$rid" ] || continue
          CONTEST_LOG="$CONTEST_LOG" RESULTS_DIR="$RESULTS_DIR" HC_BIN="$HC_BIN" bash runner/hc/collect.sh "$rid" >/dev/null 2>&1 && log "regraded: $(summary "$rid")"
        done
        [ -f runner/tokens.mjs ] && node runner/tokens.mjs --backfill --results "$RESULTS_DIR" >/dev/null 2>&1
      fi
      publish
      log "all work done (active queue jobs: $active) -> putting the machine to sleep"
      powershell.exe -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', \$false, \$false)" >/dev/null 2>&1
      exit 0
    fi
  fi
  [ "$AUTOPILOT_ONCE" = 1 ] && break
  sleep "$INTERVAL"
done
