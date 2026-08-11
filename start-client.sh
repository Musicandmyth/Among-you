#!/usr/bin/env bash
# --- Among You: start the client (P2P host/join happens inside it) ---
# Linux / macOS counterpart of start-client.bat.
set -e

# Work from the script's own directory.
cd "$(dirname "$0")"

# Ensure Node.js is available.
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js was not found. Install it (e.g. 'sudo apt install nodejs npm',"
  echo "  'brew install node', or from https://nodejs.org/) and retry."
  echo
  exit 1
fi

# Force a clean install with `./start-client.sh --reinstall` — useful if a
# node_modules dir was copied from another OS (native binaries won't match).
if [ "$1" = "--reinstall" ] || [ "$1" = "clean" ]; then
  echo "Removing node_modules for a clean install..."
  rm -rf node_modules
fi

# Install dependencies the first time.
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies (first run)..."
  npm install
fi

# Pick a browser opener for this platform (best-effort; ignored if none found).
open_cmd=""
if command -v xdg-open >/dev/null 2>&1; then
  open_cmd="xdg-open"          # most Linux desktops
elif command -v open >/dev/null 2>&1; then
  open_cmd="open"             # macOS
fi

# Open the browser shortly after the server comes up.
if [ -n "$open_cmd" ]; then
  ( sleep 3; "$open_cmd" "http://localhost:5173/" >/dev/null 2>&1 || true ) &
fi

echo
echo "  Starting client at http://localhost:5173/"
echo "  Create a game to host, or join with a room code. Press Ctrl+C to stop."
echo
exec npm run dev
