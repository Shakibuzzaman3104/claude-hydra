#!/bin/bash
# Claude Code statusline: model | 5h remaining | 7d remaining
# Reads the status line JSON payload from stdin.

input=$(cat)

WIDTH=10

if command -v jq >/dev/null 2>&1; then
  model=$(printf '%s' "$input" | jq -r '.model.display_name // empty' 2>/dev/null)
  five_used=$(printf '%s' "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty' 2>/dev/null)
  five_reset=$(printf '%s' "$input" | jq -r '.rate_limits.five_hour.resets_at // empty' 2>/dev/null)
  week_used=$(printf '%s' "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty' 2>/dev/null)
  week_reset=$(printf '%s' "$input" | jq -r '.rate_limits.seven_day.resets_at // empty' 2>/dev/null)
  ctx_remaining=$(printf '%s' "$input" | jq -r '.context_window.remaining_percentage // empty' 2>/dev/null)
elif command -v python3 >/dev/null 2>&1; then
  # jq isn't available; fall back to python3 for JSON parsing.
  eval "$(printf '%s' "$input" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
def s(v):
    return "" if v is None else str(v).replace("\x27", "")
model = (d.get("model") or {}).get("display_name") or ""
rl = d.get("rate_limits") or {}
five = rl.get("five_hour") or {}
week = rl.get("seven_day") or {}
cw = d.get("context_window") or {}
print("model=" + repr(s(model)))
print("five_used=" + repr(s(five.get("used_percentage", ""))))
print("five_reset=" + repr(s(five.get("resets_at", ""))))
print("week_used=" + repr(s(week.get("used_percentage", ""))))
print("week_reset=" + repr(s(week.get("resets_at", ""))))
print("ctx_remaining=" + repr(s(cw.get("remaining_percentage", ""))))
' 2>/dev/null)"
else
  # No jq or python3: best-effort model name via grep, skip usage data.
  model=$(printf '%s' "$input" | grep -o '"display_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')
  five_used=""
  five_reset=""
  week_used=""
  week_reset=""
  ctx_remaining=$(printf '%s' "$input" | grep -o '"remaining_percentage"[[:space:]]*:[[:space:]]*[0-9.eE+-]*' | head -1 | sed -E 's/.*:[[:space:]]*//')
fi

[ -z "$model" ] && model="Claude"

# epoch seconds -> "03:45 PM", supporting both BSD (macOS) and GNU date.
fmt_reset() {
  local epoch="$1" out
  out=$(date -r "$epoch" "+%I:%M %p" 2>/dev/null)
  [ -z "$out" ] && out=$(date -d "@$epoch" "+%I:%M %p" 2>/dev/null)
  printf '%s' "$out"
}

# used_percentage (0-100) -> colored "[██████░░░░]" where the FILLED portion is
# what remains. Full bar = full quota = green; it drains and reddens as it goes.
bar() {
  awk -v u="$1" -v w="$WIDTH" 'BEGIN {
    split("108 107 143 144 179 180 173 174 167 131", ramp, " ")
    if (u < 0) u = 0
    if (u > 100) u = 100
    r = 100 - u
    filled = int((r * w / 100) + 0.5)
    if (filled == 0 && r > 0) filled = 1
    idx = int(u / 10) + 1
    if (idx > 10) idx = 10
    c = ramp[idx]
    printf "[\033[38;5;%dm", c
    for (i = 0; i < filled; i++) printf "█"
    printf "\033[38;5;238m"
    for (i = filled; i < w; i++) printf "░"
    printf "\033[0m] \033[38;5;%dm%.0f%%\033[0m left", c, r
  }'
}

# label, used_percentage, resets_at -> "label [bar] NN% left (reset at HH:MM AM/PM)"
segment() {
  local label="$1" used="$2" resets="$3"
  case "$used" in
    ''|*[!0-9.]*) return 0 ;;
  esac
  local b when t
  b=$(bar "$used")
  when=""
  if [ -n "$resets" ] && [ "$resets" != "null" ]; then
    t=$(fmt_reset "$resets")
    [ -n "$t" ] && when=" (reset at $t)"
  fi
  printf '%s %s%s' "$label" "$b" "$when"
}

out="$model"

five_seg=$(segment "5h" "$five_used" "$five_reset")
[ -n "$five_seg" ] && out="$out | $five_seg"

week_seg=$(segment "7d" "$week_used" "$week_reset")
[ -n "$week_seg" ] && out="$out | $week_seg"

case "$ctx_remaining" in
  ''|*[!0-9.]*) ;;
  *)
    ctx_used=$(awk -v r="$ctx_remaining" 'BEGIN { printf "%.10g", 100 - r }')
    ctx_seg=$(segment "ctx" "$ctx_used" "")
    [ -n "$ctx_seg" ] && out="$out | $ctx_seg"
    ;;
esac

# Hydra (the Claude Code mod) writes this session's line here while /hydra is on; empty otherwise.
session_id=$(printf '%s' "$input" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[A-Za-z0-9-]*"' | head -1 | sed -E 's/.*"([A-Za-z0-9-]*)"$/\1/')
hydra_file="$HOME/.claude/hydra/status/$session_id.txt"
if [ -n "$session_id" ] && [ -s "$hydra_file" ]; then
  printf '%s\n\033[38;5;179m%s\033[0m' "$out" "$(head -1 "$hydra_file")"
else
  printf '%s' "$out"
fi
