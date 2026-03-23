#!/bin/bash
# =============================================================================
# Feral worker startup script.
# Launches Claude Code in a tmux session, auto-accepts genuine startup prompts,
# and waits until Claude is ready for input before exiting.
#
# IMPORTANT: Claude Code v2.1+ has a rich TUI with a status bar that reads:
#   "⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt"
# This is NOT a prompt — it's a persistent status indicator. We must not
# interact with it. Real prompts are full-screen dialogs that block startup.
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
# Set a larger history limit so capture-pane has more to work with.
# The trailing `sleep` keeps the session alive if claude exits so we can read errors.
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

# ---------------------------------------------------------------------------
# Wait for Claude to become ready.
#
# Claude Code v2.1+ startup sequence:
#   1. Brief loading/spinner
#   2. Possibly: trust prompt ("Do you trust the files in this folder?")
#      - This is a BLOCKING dialog with numbered options
#   3. Possibly: login/API key prompt (blocking)
#   4. Welcome banner appears (box-drawing ╭╰, "Welcome back", etc.)
#   5. Input prompt: ❯  (this is the ready signal)
#   6. Status bar at bottom: "⏵⏵ bypass permissions on (shift+tab to cycle)"
#      THIS IS NOT A PROMPT — never interact with it!
#
# The key insight: we only need to detect (and respond to) blocking dialogs
# that prevent Claude from reaching the ❯ prompt. Once we see ❯, we're done.
# ---------------------------------------------------------------------------

MAX_WAIT=30
READY=false
TRUST_HANDLED=false
LAST_PANE=""

for i in $(seq 1 $MAX_WAIT); do
  sleep 1

  PANE=$(capture_pane)

  # Skip if nothing has changed yet
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

  # -------------------------------------------------------------------------
  # CHECK FOR READY STATE FIRST (most common path after first startup)
  # The ❯ character is Claude Code's input prompt. When it appears on its
  # own line (possibly with whitespace), Claude is ready for input.
  # Also check for the "bypass permissions on" status bar — this only
  # appears once Claude is fully loaded and in dangerous mode.
  # -------------------------------------------------------------------------
  if echo "$PANE" | grep -qE '❯|bypass permissions on'; then
    echo "  [$i] Claude is ready (input prompt detected)."
    READY=true
    break
  fi

  # -------------------------------------------------------------------------
  # BLOCKING PROMPT: Trust dialog
  # Shows "Do you trust the files in this folder?" with numbered options.
  # Only handle this once to avoid re-triggering on stale pane content.
  # -------------------------------------------------------------------------
  if [ "$TRUST_HANDLED" = false ] && echo "$PANE" | grep -qi "Do you trust"; then
    echo "  [$i] Answering trust prompt (selecting option 1)..."
    send_keys "1" Enter
    TRUST_HANDLED=true
    sleep 2
    continue
  fi

  # -------------------------------------------------------------------------
  # BLOCKING PROMPT: Login / API key
  # Only match explicit "Enter your API key" or "Please log in" prompts,
  # NOT the status bar or welcome text that might mention "API".
  # -------------------------------------------------------------------------
  if echo "$PANE" | grep -qi "Enter your API key\|Please log in\|Login required\|No API key found"; then
    echo "  [$i] Dismissing login/API key prompt..."
    send_keys Enter
    sleep 2
    continue
  fi

  echo "  [$i] Waiting... ($(echo "$PANE" | grep -cv '^$') non-empty lines in pane)"
done

if [ "$READY" = true ]; then
  echo "Claude is ready in tmux session '$SESSION'."
  exit 0
else
  # Even if we timed out, check if the session is alive
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "WARNING: Timed out waiting for Claude ready signal, but session '$SESSION' is alive."
    echo "--- Last pane content (last 10 lines) ---"
    capture_pane | tail -10
    echo "---"
    echo "Proceeding anyway (session exists)."
    exit 0
  else
    echo "ERROR: tmux session '$SESSION' is gone. Claude failed to start."
    exit 3
  fi
fi
