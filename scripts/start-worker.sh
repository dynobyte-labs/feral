#!/bin/bash
# =============================================================================
# Feral worker startup script.
# Launches Claude Code in a tmux session and auto-accepts all startup prompts.
# Usage: bash scripts/start-worker.sh <session-name> <work-dir>
# =============================================================================

SESSION="$1"
WORK_DIR="$2"

if [ -z "$SESSION" ] || [ -z "$WORK_DIR" ]; then
  echo "Usage: start-worker.sh <session-name> <work-dir>"
  exit 1
fi

# Kill any existing session with this name
tmux kill-session -t "$SESSION" 2>/dev/null || true

# Start a new detached tmux session running claude
tmux new-session -d -s "$SESSION" -c "$WORK_DIR" \
  "claude --dangerously-skip-permissions"

echo "Session $SESSION started, waiting for prompts..."

# Helper: send keys to the session
send() {
  tmux send-keys -t "$SESSION" "$1" Enter
}

# Helper: check if tmux pane contains a string
pane_contains() {
  tmux capture-pane -t "$SESSION" -p 2>/dev/null | grep -qi "$1"
}

# Wait for claude to fully load (up to 15 seconds), answering prompts as they appear
for i in $(seq 1 15); do
  sleep 1

  # Trust prompt: "Do you trust the files in this folder?"
  if pane_contains "trust"; then
    echo "  Answering trust prompt..."
    send "1"
    sleep 1
    continue
  fi

  # API key prompt
  if pane_contains "API key" || pane_contains "api key"; then
    echo "  Dismissing API key prompt..."
    send ""
    sleep 1
    continue
  fi

  # Dangerous mode confirmation
  if pane_contains "bypass" || pane_contains "dangerous" || pane_contains "skip-perm"; then
    echo "  Confirming dangerous mode..."
    send ""
    sleep 1
    continue
  fi

  # Claude is ready when it shows its prompt (> or the input area)
  if pane_contains "Human\|>\|What would you like"; then
    echo "  Claude is ready."
    exit 0
  fi
done

echo "  Claude loaded (timeout reached, proceeding anyway)."
exit 0
