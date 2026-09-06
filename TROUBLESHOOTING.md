# ATEM MCP Troubleshooting Guide

## The EXACT Fix for "There was an error connecting to the MCP server"

### Root Cause
Claude.ai needs the OAuth discovery endpoints to return the PUBLIC URL (https://atem-mcp.cochran.cloud), not localhost. Without this, Claude.ai can't complete the OAuth flow.

### The Fix That Works Every Time

```bash
# WRONG - This will fail with Claude.ai
TRANSPORT=http PORT=3017 npm start

# CORRECT - This works with Claude.ai
TRANSPORT=http PORT=3017 BASE_URL=https://atem-mcp.cochran.cloud npm start
```

### Why This Happens
1. Claude.ai connects to https://atem-mcp.cochran.cloud/mcp
2. Server returns 401 Unauthorized (expected)
3. Claude.ai fetches /.well-known/oauth-protected-resource/mcp
4. **If BASE_URL is not set**, server returns `http://localhost:3017` URLs
5. Claude.ai can't reach localhost, so OAuth fails
6. **If BASE_URL is set**, server returns `https://atem-mcp.cochran.cloud` URLs
7. Claude.ai completes OAuth flow successfully

### Quick Test
```bash
# This should return https://atem-mcp.cochran.cloud URLs, not localhost
curl -s https://atem-mcp.cochran.cloud/.well-known/oauth-authorization-server | jq .
```

## Common Issues and Solutions

### Issue: "Unauthorized" errors in logs
**This is NORMAL** - Claude.ai first tries without auth, gets 401, then does OAuth flow.
Look for these log patterns:
```
[AUTH] 401 — no Bearer token     # First attempt - NORMAL
[OAUTH] register: claude          # OAuth flow starts - GOOD
[AUTH] ✓ Bearer xxx... known=false   # Token accepted - SUCCESS
```

### Issue: Server requires specific AUTH=none
**Solution:** The current version accepts ANY Bearer token. AUTH=none is not implemented and not needed.

### Issue: Old processes still running
**Solution:** Kill all processes before starting:
```bash
pkill -f "node.*3017"
lsof -ti:3017 | xargs kill -9
```

### Issue: Cloudflare tunnel down
**Solution:** Check tunnel status and restart:
```bash
ps aux | grep cloudflared | grep 3017
# If not running:
cloudflared tunnel --config ~/.cloudflared/atem-mcp-3017-config.yml run
```

## Production Start Script

Use the provided script for consistent starts:
```bash
cd ~/atem-mcp-server
./start-production.sh
```

This script:
1. Kills any existing processes
2. Starts with correct BASE_URL
3. Connects to ATEM automatically

## Critical Configuration

| Variable | Required Value | Why |
|----------|----------------|-----|
| TRANSPORT | http | Required for Claude.ai |
| PORT | 3017 | Mapped in Cloudflare tunnel |
| BASE_URL | https://atem-mcp.cochran.cloud | **CRITICAL for OAuth** |
| ATEM_HOST | 192.168.6.136 | Auto-connects to ATEM |

## What NOT to Do

1. **DON'T** remove OAuth endpoints - Claude.ai needs them
2. **DON'T** try to validate Bearer tokens - accept ANY token
3. **DON'T** forget BASE_URL - this breaks everything
4. **DON'T** change the port - Cloudflare tunnel expects 3017

## Emergency Recovery

If completely broken:
```bash
# 1. Go to stable code
cd ~/atem-mcp-server
git checkout main
git pull

# 2. Clean rebuild
rm -rf node_modules dist
npm install
npm run build

# 3. Start with EXACT command
TRANSPORT=http PORT=3017 BASE_URL=https://atem-mcp.cochran.cloud npm start
```

## Monitoring Health

```bash
# Local check
curl http://localhost:3017/health

# Public check (through tunnel)
curl https://atem-mcp.cochran.cloud/health

# OAuth discovery check (MUST return public URLs)
curl -s https://atem-mcp.cochran.cloud/.well-known/oauth-authorization-server | grep "atem-mcp.cochran.cloud"
```

Remember: BASE_URL is the KEY. Without it, Claude.ai can't connect.