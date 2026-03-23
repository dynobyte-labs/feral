#!/bin/bash
# =============================================================================
# Feral worker startup script.
# Launches Claude Code in a tmux session, auto-accepts all startup prompts,
# and waits until Claude is ready for input before exiting.
#
# Usage: bash scripts/start-worker.sh <session-name> <work-dir>
# Exit codes:
#   0 = Claude is ready for input
#   1 = Usage error
#   2 = tmux session failed to start
#   3 = Claude never became ready (timeout)
# =============================================================================

set -euo pipefail

SESSION="$1"
WORK_DIR="$2"

if [ -z "$SESSION" ] || [ -z "$WORK_DIR" ]; then
  echo "Usage: start-worker.sh <session-name> <work-dir>"
  exit 1
fi

# Kill any existing session with this name (clean slate)
tmux kill-session -t "$SESSION" 2>/dev/null || true
sleep 0.5

# Start a new detached tmux session running claude
# Set a larger history limit so capture-pane has more to work with
tmux new-session -d -s "$SESSION" -c "$WORK_DIR" -x 200 -y 50 \
  "claude --dangerously-skip-permissions 2>&1; echo '___FERAL_CLAUDE_EXITED___'; sleep 86400"

# Verify session actually started
sleep 0.5
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "ERROR: tmux session '$SESSION' failed to start"
  exit 2
fi

echo "Session '$SESSION' started in '$WORK_DIR'. Waiting for Claude to be ready..."

# Helper: capture the current pane content
capture_pane() {
  tmux capture-pane -t "$SESSION" -p -S -100 2>/dev/null || echo ""
}

# Helper: send a key sequence to the session
send_keys() {
  tmux send-keys -t "$SESSION" "$@"
}

# Wait for Claude to fully load, answering prompts as they appear.
# Claude Code shows various prompts during startup depending on config.
# We need to handle: trust prompt, API key prompt, dangerous mode confirmation.
# When ready, Claude shows a text input area or ">" prompt.

MAX_WAIT=30
READY=false
LAST_PANE=""

for i in $(seq 1 $MAX_WAIT); do
  sleep 1

  PANE=$(capture_pane)

  # Skip if pane hasn't changed and it's early (still loading)
  if [ "$PANE" = "$LAST_PANE" ] && [ $i -lt 5 ]; then
    continue
  fi
  LAST_PANE="$PANE"

  # Check if Claude exited unexpectedly
  if echo "$PANE" | grep -q "___FERAL_CLAUDE_EXITED___"; then
    echo "ERROR: Claude process exited unexpectedly"
    echo "--- Last output ---"
    echo "$PANE" | tail -20
    exit 3
  fi

  # Trust prompt: "Do you trust the files in this folder?" or similar
  # Usually shows numbered options — send "1" to trust
  if echo "$PANE" | grep -qi "trust.*files\|trust.*folder\|Do you trust"; then
    echo "  [$i] Answering trust prompt (selecting option 1)..."
    send_keys "1" Enter
    sleep 2
    continue
  fi

  # API key / login prompt
  if echo "$PANE" | grep -qi "API key\|api.key\|Enter.*key\|login\|authenticate"; then
    echo "  [$i] Dismissing API/login prompt..."
    send_keys Enter
    sleep 2
    continue
  fi

  # Dangerous mode / permissions confirmation
  if echo "$PANE" | grep -qi "bypass\|dangerous\|skip-perm\|permission.*skip\|confirm.*dangerous"; then
    echo "  [$i] Confirming dangerous mode..."
    send_keys Enter
    sleep 2
    continue
  fi

  # Terms / agreement prompt
  if echo "$PANE" | grep -qi "terms\|agree\|accept\|license"; then
    echo "  [$i] Accepting terms..."
    send_keys "y" Enter
    sleep 2
    continue
  fi

  # Check if Claude is ready — look for the input prompt
  # Claude Code shows ">" or "╭" (box drawing) or "What can I help" or similar
  if echo "$PANE" | grep -qE '>\s*$|╭|╰|What can I help|What would you like|Tip:|waiting for input|human turn'; then
    echo "  [$i] Claude is ready."
    READY=true
    break
  fi

  # Also check: if we're past 10 seconds and pane has content but no known prompt,
  # Claude might be ready with an unfamiliar prompt style
  if [ $i -ge 15 ] && [ -n "$PANE" ]; then
    # Check if the last line looks like an input prompt (ends with cursor-like characters)
    LAST_LINE=$(echo "$PANE" | grep -v '^$' | tail -1)
    if echo "$LAST_LINE" | grep -qE '^\s*[>$%#]|^\s*claude|input'; then
      echo "  [$i] Claude appears ready (prompt detected: $LAST_LINE)"
      READY=true
      break
    fi
  fi

  echo "  [$i] Waiting... ($(echo "$PANE" | wc -l | tr -d ' ') lines in pane)"
done

if [ "$READY" = true ]; then
  echo "Claude is ready in tmux session '$SESSION'."
  exit 0
else
  # Even if we timed out, check if the session is alive — Claude might just have
  # a different prompt style than we expected
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "WARNING: Timed out waiting for Claude ready signal, but session '$SESSION' is alive."
    echo "--- Last pane content ---"
    capture_pane | tail -10
    echo "---"
    echo "Proceeding anyway (session exists)."
    exit 0
  else
    echo "ERROR: tmux session '$SESSION' is gone. Claude failed to start."
    exit 3
  fi
fi
