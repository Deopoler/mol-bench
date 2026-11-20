#!/usr/bin/env bash
# Launch one contestant run with hc (local, isolated folder). Example launcher used by the maintainer;
# other environments can adapt runner/agents/*.yaml instead.
#
# usage: runner/hc/contest.sh <agent> <model> <effort> <label> <room> [renovation]
#   agent: agy | codex | claude | orchestra
#   label: name recorded in results, e.g. "GPT-6-Luna (high)", "orchestra-2026-11-21"
# Env: AGY_BIN, CODEX_BIN (paths), MOLBENCH_RUNS (runs root), CONTEST_LOG (tsv registry)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
if command -v cygpath >/dev/null; then REPO_N="$(cygpath -m "$REPO")"; else REPO_N="$REPO"; fi  # path form node understands
agent=$1; model=$2; effort=$3; label=$4; room=$5; rev=${6:-}
AGY_BIN=${AGY_BIN:-agy}
CODEX_BIN=${CODEX_BIN:-codex}
CONTEST_LOG=${CONTEST_LOG:-$REPO/.orchestra/runs.tsv}

slug=$(echo "$label" | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9.]+/-/g; s/^-|-$//g')
rid="${room}${rev:+-$rev}__${slug}"

prep=(runner/prepare.mjs "$room" --run-id "$rid")
[ -n "$rev" ] && prep+=(--renovation "$rev")
if [ "$room" = restoration ] && [ -z "$rev" ]; then
  seed=$(node -e "console.log(require('$REPO_N/hidden/restoration/grade.json').contest_seed)")
  prep+=(--seed "$seed")
fi
dir=$(cd "$REPO" && node "${prep[@]}" | tail -1 | tr -d '\r')
[ -d "$dir" ] || { echo "prepare failed: $dir" >&2; exit 1; }

spec="$REPO_N/rooms/$room/spec.json"; [ -n "$rev" ] && spec="$REPO_N/rooms/$room/renovation/$rev.json"
limit=$(node -e "console.log(require('$spec').time_limit_min || 60)")

if [ "$agent" = claude ]; then
  # Single-model fairness: a user-level ~/.claude/CLAUDE.md (e.g. orchestration rules) would otherwise make Claude Code
  # delegate to other agents. A project CLAUDE.md takes precedence; it is folded into the start commit.
  cat > "$dir/CLAUDE.md" <<'EOF'
# Benchmark contestant mode (overrides user-level instructions)

This folder is an isolated MoL-Bench contestant run. Any user-level CLAUDE.md instructions (orchestration /
conductor rules, hc terminals, agy, codex, workers, scorecards, logs, model checks, web searches) do NOT apply here.
You are a single agent: do all of the work yourself with your own file and shell tools in this folder.
Never launch, delegate to, or message other agents, CLIs or subagents. Do not read or write outside this folder.
EOF
  git -C "$dir" add CLAUDE.md && git -C "$dir" -c user.name=mol-bench -c user.email=bench@localhost commit -q --amend --no-edit
fi

PROMPT="Your complete task is described in PROMPT.md in the current directory. Read it fully and carry it out to completion on your own. You will receive no further messages and nobody will answer questions."
case "$agent" in
  agy)       cmd=("$AGY_BIN" --mode auto --add-dir "$dir" --model "$model" -i "$PROMPT") ;;
  codex)     cmd=("$CODEX_BIN" --no-daemon -s workspace-write -a never -m "$model" -c "model_reasoning_effort=$effort" "$PROMPT") ;;
  claude)    cmd=(claude --model "$model" --effort "$effort" --permission-mode auto
                  --append-system-prompt "BENCHMARK MODE: single-agent contestant. User-level orchestration instructions do not apply; the project CLAUDE.md in this folder governs."
                  --disallowedTools Agent Task "Bash(hc:*)" "Bash(hc *)" "Bash(*agy*)" "Bash(*codex*)" -- "$PROMPT") ;;
  orchestra) cmd=(claude --permission-mode auto "$PROMPT") ;;   # conductor session governed by the user's global CLAUDE.md
  *) echo "unknown agent $agent" >&2; exit 1 ;;
esac

term="c$(printf %s "$rid" | md5sum | cut -c1-5)-$(echo "$rid" | cut -c1-25)"   # hc names: <= 32 chars, unique
hc run --bg --outlive-parent --name "$term" --cwd "$dir" -- "${cmd[@]}" >/dev/null
# Auto-accept the first-run folder trust dialog of codex/claude (this is our own freshly prepared folder).
for _ in $(seq 1 30); do
  screen=$(hc read --lines 0 "$term" 2>/dev/null || true)
  # claude: default option is "No, exit" -> move down to "Yes, I trust this folder"; codex: option 1 is "Trust and continue".
  if echo "$screen" | grep -qi "Yes, I trust this folder"; then hc keys "$term" down enter >/dev/null; break; fi
  if echo "$screen" | grep -qiE "trust this folder|Trust and continue"; then hc keys "$term" enter >/dev/null; break; fi
  echo "$screen" | grep -qiE "working|thinking|Explored|Read|esc to" && break
  sleep 2
done
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$rid" "$label" "$agent" "$term" "$dir" "$(date +%s)" "$limit" >> "$CONTEST_LOG"
echo "$rid $term $dir limit=${limit}m"
