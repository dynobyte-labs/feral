#!/bin/bash
# =============================================================================
# Install git hooks for Feral
# Adds a pre-commit hook that blocks accidental credential commits.
# Usage: bash scripts/install-hooks.sh
# =============================================================================
set -e

FERAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS_DIR="$FERAL_DIR/.git/hooks"

mkdir -p "$HOOKS_DIR"

cat > "$HOOKS_DIR/pre-commit" << 'HOOKEOF'
#!/bin/bash
# =============================================================================
# Feral pre-commit hook — blocks credential leaks
# =============================================================================

# Patterns that should never appear in a commit
PATTERNS=(
  'sk-ant-[a-zA-Z0-9]'          # Anthropic API keys
  'xoxb-[0-9]'                   # Slack bot tokens
  'xapp-[0-9]'                   # Slack app tokens
  'ghp_[a-zA-Z0-9]'              # GitHub personal access tokens
  'github_pat_[a-zA-Z0-9]'       # GitHub fine-grained PATs
  'sk-[a-zA-Z0-9]{20,}'          # OpenAI API keys
  'r8_[a-zA-Z0-9]'               # Replicate tokens
  'PRIVATE KEY'                   # SSH/TLS private keys
  'discord\.com.*token'           # Discord tokens
)

STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACMR)

if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

FOUND=0

for pattern in "${PATTERNS[@]}"; do
  # Search staged content (not working tree)
  MATCHES=$(git diff --cached -U0 | grep -iE "$pattern" | grep "^+" | grep -v "^+++" || true)

  if [ -n "$MATCHES" ]; then
    if [ $FOUND -eq 0 ]; then
      echo ""
      echo "🚨 BLOCKED — Possible credentials detected in staged changes:"
      echo ""
    fi
    FOUND=1
    echo "  Pattern: $pattern"
    echo "$MATCHES" | head -3 | sed 's/^/    /'
    echo ""
  fi
done

# Also block .env files from being committed
ENV_FILES=$(echo "$STAGED_FILES" | grep -E '^\.(env|env\.local|env\.production)$' || true)
if [ -n "$ENV_FILES" ]; then
  if [ $FOUND -eq 0 ]; then
    echo ""
    echo "🚨 BLOCKED — Sensitive files detected in staged changes:"
    echo ""
  fi
  FOUND=1
  echo "  Files: $ENV_FILES"
  echo "  These files contain secrets and should not be committed."
  echo "  They are already in .gitignore — did you force-add them?"
  echo ""
fi

if [ $FOUND -ne 0 ]; then
  echo "  To commit anyway (if this is a false positive):"
  echo "    git commit --no-verify"
  echo ""
  exit 1
fi

exit 0
HOOKEOF

chmod +x "$HOOKS_DIR/pre-commit"

echo "Pre-commit hook installed."
echo "  Location: $HOOKS_DIR/pre-commit"
echo "  Blocks: API keys, tokens, private keys, .env files"
echo ""
