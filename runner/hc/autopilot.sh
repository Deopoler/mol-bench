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
LOG=${LOG:-$REPO/.orchestra/autopilot.log}
MAXPAR=${MAXPAR:-3}
INTERVAL=${INTERVAL:-300}
QUOTA=${QUOTA:-$HOME/.claude/orchestra/quota.py}
export AGY_BIN=${AGY_BIN:-agy} CODEX_BIN=${CODEX_BIN:-codex}
last_launch=$(date +%s)
log() { echo "[$(date '+%m-%d %H:%M')] $*" | tee -a "$LOG"; }

summary() {
  python -c "
import json,sys
d=json.load(open('results/$1.json'))
ax=d.get('axes',{}); g=[k for k,v in d.get('gates',{}).items() if v.get('pass') is False]
print('%s composite=%.2f %s wall=%.1fm %s'%('$1',d.get('composite') or 0,' '.join('%s=%.2f'%(k,v) for k,v in ax.items() if v is not None),d.get('efficiency',{}).get('wall_min') or 0,('FAILGATES='+','.join(g)) if g else ''))" 2>/dev/null || echo "$1 (no result)"
}

publish() {
  node harness/src/leaderboard.mjs >/dev/null 2>&1 || log "leaderboard failed"
  [ -f harness/src/gallery.mjs ] && { node harness/src/gallery.mjs >/dev/null 2>&1 || log "gallery failed"; }
  git add results site >/dev/null 2>&1
  if ! git diff --cached --quiet; then
    git commit -qm "results: autopilot update $(date '+%m-%d %H:%M')" && (git push -q >/dev/null 2>&1 || log "push failed")
  fi
}

while true; do
  changed=0
  # 1) collect finished or over-limit runs; handle permission prompts
  while read -r rid state elapsed over; do
    [ -z "$rid" ] && continue
    term=$(awk -F'\t' -v r="$rid" '$1==r{t=$4} END{print t}' .orchestra/runs.tsv)
    case "$state" in
      done|idle|gone|error)
        [ "$state" = error ] && log "$rid ended in ERROR state ($(hc get "$term" 2>/dev/null | grep -o '"msg":"[^"]*"' | head -1))"
        bash runner/hc/collect.sh "$rid" >/dev/null 2>&1; log "collected: $(summary "$rid")"; changed=1 ;;
      blocked)
        screen=$(hc read --lines 25 "$term" 2>/dev/null)
        if echo "$screen" | grep -q "No, cancel"; then
          hc keys "$term" down down down enter >/dev/null 2>&1; sleep 3
          hc send "$term" "[harness] That command was denied by the benchmark harness (only actions inside this folder are allowed). Continue the task without it." >/dev/null 2>&1
          printf '%s\tdeny+continue\t%s\n' "$rid" "$(echo "$screen" | grep -A1 'Requesting permission' | tail -1 | tr -s ' ' | cut -c1-160)" >> .orchestra/interventions.tsv
          log "$rid: denied a permission prompt (intervention logged)"
        fi ;;
    esac
    if [ "$over" = OVER ] && [ ! -f "results/$rid.json" ]; then
      bash runner/hc/collect.sh "$rid" --timeout >/dev/null 2>&1; log "timeout-collected: $(summary "$rid")"; changed=1
    fi
  done < <(bash runner/hc/status.sh | sed 's# \([0-9]*\)m/[0-9]*m# \1#')

  # 2) launch queued jobs while capacity and quota allow
  running=$(bash runner/hc/status.sh | wc -l)
  if [ -f "$QUEUE" ] && [ "$running" -lt "$MAXPAR" ]; then
    : > "$QUEUE.next"
    while IFS=$'\t' read -r agent model effort label room rev qkey need; do
      [ -z "${agent:-}" ] && continue
      case "$agent" in \#*) echo -e "$agent\t$model\t$effort\t$label\t$room\t$rev\t$qkey\t$need" >> "$QUEUE.next"; continue ;; esac
      if [ "$running" -lt "$MAXPAR" ] && python "$QUOTA" "$qkey" --need "$need" >/dev/null 2>&1; then
        [ "$rev" = "-" ] && rev=""
        out=$(bash runner/hc/contest.sh "$agent" "$model" "$effort" "$label" "$room" $rev 2>&1 | tail -1)
        log "launched: $label on $room${rev:+-$rev} -> $out"; running=$((running + 1)); last_launch=$(date +%s)
      else
        echo -e "$agent\t$model\t$effort\t$label\t$room\t$rev\t$qkey\t$need" >> "$QUEUE.next"
      fi
    done < "$QUEUE"
    mv "$QUEUE.next" "$QUEUE"
  fi

  [ "$changed" = 1 ] && publish

  # 3) optional: put the machine to sleep when there is nothing left to do.
  #    Done = no running runs AND (no active queue jobs OR nothing could launch for STUCK_HOURS after NOT_BEFORE).
  if [ "${SLEEP_WHEN_DONE:-0}" = 1 ]; then
    running=$(bash runner/hc/status.sh | wc -l)
    active=$(grep -vc '^#' "$QUEUE" 2>/dev/null || echo 0)
    now=$(date +%s); not_before=${NOT_BEFORE_EPOCH:-0}; stuck=$(( ${STUCK_HOURS:-4} * 3600 ))
    if [ "$running" -eq 0 ] && [ "$now" -ge "$not_before" ] && { [ "$active" -eq 0 ] || [ $((now - last_launch)) -ge "$stuck" ]; }; then
      publish
      log "all work done (active queue jobs: $active) -> putting the machine to sleep"
      powershell.exe -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', \$false, \$false)" >/dev/null 2>&1
      exit 0
    fi
  fi
  sleep "$INTERVAL"
done
