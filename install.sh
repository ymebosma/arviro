#!/usr/bin/env bash
# Installs or updates Arviro on macOS or Linux, for the user who runs it:
#   1. checks for Node.js 22 or newer (and installs it with Homebrew on macOS);
#   2. installs the helper programs with Homebrew or the Linux package manager (poppler, osmium-tool, and Ollama on macOS);
#   3. puts the code in ~/arviro (or $ARVIRO_HOME) with git and installs its npm packages;
#   4. lets Arviro download kiwix-tools and the embedding model (`arviro setup`);
#   5. starts Arviro now and at every login (`arviro service install`) and opens the admin page.
#
#   curl -fsSL https://raw.githubusercontent.com/ymebosma/arviro/main/install.sh | bash
#   bash install.sh [--no-tools] [--no-service]      --no-tools: skip step 2;  --no-service: skip step 5
#
# Run it again to update: it pulls the newest code and restarts the service.
set -euo pipefail

ARVIRO_HOME="${ARVIRO_HOME:-$HOME/arviro}"
ARVIRO_REPO="${ARVIRO_REPO:-https://github.com/ymebosma/arviro.git}"
TOOLS=1
SERVICE=1
for argument in "$@"; do
  case "$argument" in
    --no-tools) TOOLS=0 ;;
    --no-service) SERVICE=0 ;;
    -h|--help) echo "Usage: bash install.sh [--no-tools] [--no-service]   (ARVIRO_HOME=$ARVIRO_HOME)"; exit 0 ;;
    *) echo "Unknown option: $argument" >&2; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
node_ok() { have node && [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 22 ]; }

case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux) OS=linux ;;
  *) echo "This script is for macOS and Linux. On Windows, run install.ps1 in PowerShell." >&2; exit 1 ;;
esac

# The package manager, if there is one that this script knows.
PKG=""
if [ "$OS" = mac ]; then
  have brew && PKG=brew
else
  for candidate in apt-get dnf pacman; do
    if have "$candidate"; then PKG=$candidate; break; fi
  done
fi

# install_package <brew name> <apt name> <dnf name> <pacman name>
install_package() {
  case "$PKG" in
    brew) brew install "$1" ;;
    apt-get) sudo apt-get install -y "$2" ;;
    dnf) sudo dnf install -y "$3" ;;
    pacman) sudo pacman -S --needed --noconfirm "$4" ;;
    *) return 1 ;;
  esac
}

if [ "$OS" = mac ] && [ -z "$PKG" ]; then
  echo "Homebrew was not found. It installs Node.js and the helper programs; get it from https://brew.sh and run this script again,"
  echo "or install Node.js from https://nodejs.org yourself and run the script with --no-tools."
  if [ "$TOOLS" = 1 ] && ! node_ok; then exit 1; fi
fi

say "Git"
if ! have git; then
  install_package git git git git || { echo "Install git first (https://git-scm.com) and run this script again." >&2; exit 1; }
fi
git --version

say "Node.js"
if ! node_ok; then
  if [ "$PKG" = brew ]; then
    brew install node
  else
    echo "Node.js 22 or newer is needed. The Linux package managers ship older versions; install it from https://nodejs.org" >&2
    echo "or https://github.com/nodesource/distributions, then run this script again." >&2
    exit 1
  fi
fi
node --version

if [ "$TOOLS" = 1 ] && [ -n "$PKG" ]; then
  say "Helper programs"
  have pdftotext || install_package poppler poppler-utils poppler-utils poppler
  have osmium || install_package osmium-tool osmium-tool osmium-tool osmium-tool
  if ! have ollama; then
    if [ "$PKG" = brew ]; then
      brew install ollama && brew services start ollama
    else
      echo "Ollama gives Arviro search by meaning and the Chat tab. Install it with:  curl -fsSL https://ollama.com/install.sh | sh"
    fi
  fi
elif [ "$TOOLS" = 1 ]; then
  echo "No package manager found; the admin page shows how to install poppler, osmium-tool and Ollama by hand."
fi

say "Arviro in $ARVIRO_HOME"
if [ -d "$ARVIRO_HOME/.git" ]; then
  git -C "$ARVIRO_HOME" pull --ff-only
elif [ -e "$ARVIRO_HOME" ]; then
  echo "$ARVIRO_HOME exists but is not a checkout of Arviro. Move it away, or set ARVIRO_HOME to another folder." >&2
  exit 1
else
  git clone "$ARVIRO_REPO" "$ARVIRO_HOME"
fi
npm --prefix "$ARVIRO_HOME" install --no-fund --no-audit

say "kiwix-tools and the embedding model"
# A missing download (no internet, Ollama not running yet) is reported, not fatal: the admin page offers it again.
node "$ARVIRO_HOME/bin/arviro.js" setup || true

if [ "$SERVICE" = 1 ]; then
  say "Service"
  node "$ARVIRO_HOME/bin/arviro.js" service install
else
  say "Done. Start Arviro with:  node $ARVIRO_HOME/bin/arviro.js serve"
fi
