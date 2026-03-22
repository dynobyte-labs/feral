#!/bin/bash
# =============================================================================
# Periodic cleanup — run weekly via cron or launchd to manage disk space.
# Usage: bash scripts/cleanup.sh
# =============================================================================
set -e

echo "Claude Dev Farm — Cleanup"
echo "========================="

PROJECTS_DIR="${PROJECTS_DIR:-$HOME/projects}"
WORKTREES_DIR="$PROJECTS_DIR/.worktrees"

# 1. Prune git worktrees
echo ""
echo "[1] Pruning git worktrees..."
if [ -d "$PROJECTS_DIR" ]; then
  for repo in "$PROJECTS_DIR"/*/; do
    if [ -d "$repo/.git" ]; then
      echo "  Pruning: $(basename "$repo")"
      cd "$repo" && git worktree prune 2>/dev/null || true
    fi
  done
fi

# Remove orphaned worktree directories
if [ -d "$WORKTREES_DIR" ]; then
  echo "  Checking for orphaned worktrees..."
  for wt in "$WORKTREES_DIR"/*/; do
    if [ ! -f "$wt/.git" ]; then
      echo "  Removing orphaned: $(basename "$wt")"
      rm -rf "$wt"
    fi
  done
fi

# 2. Clean Xcode derived data
echo ""
echo "[2] Cleaning Xcode derived data..."
DERIVED_DATA="$HOME/Library/Developer/Xcode/DerivedData"
if [ -d "$DERIVED_DATA" ]; then
  SIZE=$(du -sh "$DERIVED_DATA" 2>/dev/null | cut -f1)
  echo "  DerivedData size: $SIZE"
  # Only clean entries older than 7 days
  find "$DERIVED_DATA" -maxdepth 1 -mindepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true
  echo "  Cleaned entries older than 7 days."
fi

# 3. Docker cleanup
echo ""
echo "[3] Docker cleanup..."
if command -v docker &>/dev/null; then
  docker system prune -f --volumes 2>/dev/null || echo "  Docker not running."
else
  echo "  Docker not installed."
fi

# 4. npm cache
echo ""
echo "[4] Cleaning npm cache..."
npm cache clean --force 2>/dev/null || true

# 5. Disk usage summary
echo ""
echo "[5] Disk usage summary..."
echo "  Projects:     $(du -sh "$PROJECTS_DIR" 2>/dev/null | cut -f1)"
echo "  Worktrees:    $(du -sh "$WORKTREES_DIR" 2>/dev/null | cut -f1)"
echo "  Farm data:    $(du -sh "$HOME/claude-dev-farm/data" 2>/dev/null | cut -f1)"
echo "  Total disk:   $(df -h / | tail -1 | awk '{print $3 "/" $2 " used (" $5 ")"}')"
echo ""
echo "Cleanup complete."
