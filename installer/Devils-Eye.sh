#!/usr/bin/env bash
# Launch Devil's Eye. Close this window to stop the app.
cd "$(dirname "$0")" || exit 1
NODE="node"
if [ -x "runtime/node/bin/node" ]; then
  NODE="$(pwd)/runtime/node/bin/node"
elif ! command -v node >/dev/null 2>&1; then
  echo "Devil's Eye needs Node.js but it was not found." >&2
  echo "Run the installer again to bundle a runtime, or install Node from https://nodejs.org" >&2
  exit 1
fi
exec "$NODE" launcher-app.mjs