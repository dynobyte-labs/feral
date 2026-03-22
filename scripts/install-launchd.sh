#!/bin/bash
# =============================================================================
# Install a launchd agent so the orchestrator starts automatically on login.
# Usage: bash scripts/install-launchd.sh
# =============================================================================
set -e

FERAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_NAME="com.feral.orchestrator"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
NODE_PATH="$(which node)"
NPX_PATH="$(which npx)"

echo "Installing launchd agent..."
echo "  Farm directory: $FERAL_DIR"
echo "  Node: $NODE_PATH"

# Build first
echo "  Building TypeScript..."
cd "$FERAL_DIR" && npm run build

cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${FERAL_DIR}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${FERAL_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${FERAL_DIR}/data/logs/launchd-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${FERAL_DIR}/data/logs/launchd-stderr.log</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
EOF

# Load the agent
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

echo ""
echo "Done! The orchestrator will now start automatically on login."
echo "  Plist: $PLIST_PATH"
echo ""
echo "Management commands:"
echo "  launchctl start ${PLIST_NAME}     # Start now"
echo "  launchctl stop ${PLIST_NAME}      # Stop"
echo "  launchctl unload ${PLIST_PATH}    # Disable auto-start"
echo "  tail -f ${FERAL_DIR}/data/logs/launchd-stdout.log  # View logs"
echo ""
