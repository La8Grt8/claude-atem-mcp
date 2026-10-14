#!/bin/zsh
# Adds this ATEM MCP server to Claude Desktop (macOS).
# Quit Claude Desktop fully (Cmd+Q) BEFORE running.
# Usage: ./add-to-claude-desktop.sh [ATEM_IP]
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

if [ ! -f "$DIR/dist/index.js" ]; then
  echo "Build first: npm install --include=dev && npm run build"; exit 1
fi
mkdir -p "$(dirname "$CFG")"
[ -f "$CFG" ] && cp "$CFG" "$CFG.atem.backup"

"$NODE" -e '
const fs = require("fs");
const [f, node, entry, ip] = process.argv.slice(1);
let c = {};
try { c = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
c.mcpServers = c.mcpServers || {};
c.mcpServers.atem = { command: node, args: [entry], ...(ip ? { env: { ATEM_HOST: ip } } : {}) };
fs.writeFileSync(f, JSON.stringify(c, null, 2));
console.log("ATEM added to Claude Desktop" + (ip ? " (auto-connects to " + ip + ")" : "") + ". Reopen Claude Desktop.");
' "$CFG" "$NODE" "$DIR/dist/index.js" "$1"
