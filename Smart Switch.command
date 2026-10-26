#!/bin/bash
# Double-click to start the Smart Switch control panel (http://localhost:3020).
# Builds on the first run. Close this window (or press Ctrl+C) to stop it.
cd "$(dirname "$0")" || exit 1
if [ ! -d node_modules ]; then
  echo "Installing dependencies…"
  npm install --include=dev || { read -rp "Install failed. Press Return to close."; exit 1; }
fi
if [ ! -f dist/app/smart-switch-app.js ] || [ -n "$(find src app -newer dist/app/smart-switch-app.js -print -quit)" ]; then
  echo "Building…"
  npm run build || { read -rp "Build failed. Press Return to close."; exit 1; }
fi
exec node dist/app/smart-switch-app.js "$@"
