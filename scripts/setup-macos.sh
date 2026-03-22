#!/bin/bash
# =============================================================================
# Feral — macOS Setup Script
# Run on a fresh Mac Mini M4 (or any Apple Silicon Mac) dedicated to dev work.
# Usage: bash scripts/setup-macos.sh
# =============================================================================
set -e

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       Feral — macOS Setup      ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# --- Homebrew ---
echo "[1/10] Installing Homebrew..."
if ! command -v brew &>/dev/null; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"
  echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zshrc
else
  echo "  Homebrew already installed."
fi

# --- Core tools ---
echo "[2/10] Installing core tools..."
brew install node git gh tmux jq ripgrep fd wget curl htop neovim sqlite

# --- Claude Code ---
echo "[3/10] Installing Claude Code..."
npm install -g @anthropic-ai/claude-code

# --- Node.js version manager ---
echo "[4/10] Setting up fnm (Node version manager)..."
brew install fnm
echo 'eval "$(fnm env --use-on-cd)"' >> ~/.zshrc
eval "$(fnm env --use-on-cd)"
fnm install 22
fnm default 22

# --- Python ---
echo "[5/10] Installing Python..."
brew install python@3.12

# --- Tailscale ---
echo "[6/10] Installing Tailscale..."
brew install --cask tailscale
echo "  >>> Open Tailscale from Applications and sign in. <<<"

# --- Prevent sleep ---
echo "[7/10] Configuring power management (prevent sleep)..."
sudo pmset -c sleep 0 disksleep 0 displaysleep 0 standby 0 autopoweroff 0 womp 1
echo "  Sleep disabled on AC power."

# --- Firewall ---
echo "[8/10] Configuring firewall..."
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode on
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setallowsigned on
echo "  Firewall ON, stealth mode ON."

# --- SSH ---
echo "[9/10] SSH setup reminder..."
echo "  Remote Login should be enabled in System Settings > General > Sharing."
echo "  After copying your SSH key from another device, disable password auth:"
echo "    sudo nano /etc/ssh/sshd_config"
echo "    Set: PasswordAuthentication no"
echo ""

# --- Project setup ---
echo "[10/10] Setting up Feral..."
FERAL_DIR="$HOME/feral"
if [ ! -d "$FERAL_DIR" ]; then
  echo "  Cloning to $FERAL_DIR..."
  git clone https://github.com/dynobyte-labs/feral.git "$FERAL_DIR"
fi
cd "$FERAL_DIR"
npm install
mkdir -p data ~/projects

# Create .env from example if it doesn't exist
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  Created .env from .env.example — edit it with your API keys."
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║            Setup Complete!               ║"
echo "╠══════════════════════════════════════════╣"
echo "║                                          ║"
echo "║  Next steps:                             ║"
echo "║  1. Edit ~/feral/.env          ║"
echo "║  2. Open Tailscale and sign in           ║"
echo "║  3. Enable Remote Login in System Settings║"
echo "║  4. Set up auto-login in Users & Groups  ║"
echo "║  5. Install launchd agent:               ║"
echo "║     bash scripts/install-launchd.sh      ║"
echo "║  6. Test: npm run dev                    ║"
echo "║                                          ║"
echo "╚══════════════════════════════════════════╝"
echo ""
