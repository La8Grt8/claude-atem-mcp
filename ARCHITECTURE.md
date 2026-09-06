# ATEM MCP Server Architecture

## Overview
ATEM MCP Server provides Model Context Protocol (MCP) integration for Blackmagic ATEM video switchers, enabling AI assistants like Claude to control professional broadcast equipment.

## Critical Configuration

### ⚠️ DO NOT MODIFY WITHOUT READING

This server is part of a production broadcast system. Changes can break live shows.

### Port Configuration
- **Port**: 3017 (FIXED - DO NOT CHANGE)
- **Cloudflare Tunnel**: atem-mcp.cochran.cloud → localhost:3017
- **Start Command**: `TRANSPORT=http PORT=3017 BASE_URL=https://atem-mcp.cochran.cloud npm start`
- **CRITICAL**: Must set BASE_URL to public URL or Claude.ai OAuth will fail!

### Authentication
- **Current Version**: Uses OAuth flow that accepts ANY Bearer token
- **DO NOT**: Remove OAuth endpoints - Claude.ai expects them
- **DO NOT**: Add strict validation - it will break Claude.ai integration
- **Key Code**: Lines that check `auth.startsWith('Bearer ')` but accept any token

### Working Version Information
- **Last Stable Commit**: 7c3a8a9 (before OAuth was added)
- **Current Working Branch**: Check git branch -a for stable branches
- **OAuth Added In**: Commit 5410384

## Architecture Components

### 1. Transport Layer
```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Claude.ai     │────▶│ Cloudflare Tunnel│────▶│  ATEM MCP:3017  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                           │
                                                           ▼
                                                   ┌───────────────┐
                                                   │ ATEM Switcher │
                                                   │ 192.168.6.136 │
                                                   └───────────────┘
```

### 2. MCP Protocol Flow
1. Claude.ai connects to https://atem-mcp.cochran.cloud/mcp
2. Server responds with OAuth discovery endpoints
3. Claude performs OAuth flow (server accepts any token)
4. Claude sends MCP commands with Bearer token
5. Server executes ATEM commands

### 3. Key Files
- `src/index.ts` - Main server with OAuth handling
- `src/services/atem-connection.ts` - ATEM connection management
- `src/tools/*.ts` - Individual tool implementations

### 4. OAuth Endpoints (Required by Claude.ai)
- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server`
- `/authorize` - Issues auth codes
- `/token` - Issues Bearer tokens (accepts any credentials)
- `/register` - Dynamic client registration

### 5. MCP Endpoints
- `POST /mcp` - Main MCP endpoint (requires Bearer token)
- `GET /health` - Health check
- `GET /mcp` - Returns 405 (method not allowed)

## Common Issues and Fixes

### Issue: "There was an error connecting to the MCP server"
**Cause**: Claude.ai can't complete OAuth flow
**Fix**: Ensure OAuth endpoints exist and accept any token

### Issue: Server requires authentication
**Cause**: Code checking for specific tokens or AUTH=none not implemented
**Fix**: Make auth check accept ANY Bearer token, don't validate

### Issue: Cloudflare tunnel down
**Fix**:
```bash
cloudflared tunnel --config ~/.cloudflared/atem-mcp-3017-config.yml run
```

## Deployment Checklist

Before making ANY changes:
- [ ] Test on different port (3018) first
- [ ] Ensure OAuth endpoints still exist
- [ ] Verify Bearer token acceptance (not validation)
- [ ] Check Cloudflare tunnel is running
- [ ] Test with Claude.ai MCP connector

## Recovery Procedures

### If server stops working:
1. Check running processes: `ps aux | grep -E "atem.*3017"`
2. Check logs: `docker logs <container-id>` if containerized
3. Revert to known working version:
   ```bash
   git checkout 7c3a8a9  # Pre-OAuth version
   # OR
   git checkout stable-no-auth  # If branch exists
   ```
4. Rebuild: `npm run build`
5. Restart: `TRANSPORT=http PORT=3017 npm start`

### Creating stable branch:
```bash
git checkout -b stable-production
git add -A && git commit -m "Stable production version"
git push origin stable-production
```

## Integration with Other Services

### Related MCP Servers (DO NOT BREAK):
- **PTZ MCP**: https://ptz-mcp.cochran.cloud (port 3008)
- **DMX MCP**: https://dmx-mcp.cochran.cloud/mcp (port 3006)
- **ZoomISO MCP**: https://zoomiso-mcp-test.cochran.cloud/mcp (port 3015)

### Production Bots Dashboard
- Uses all MCP servers via Claude API
- URL: https://prodbots.cochran.cloud
- Expects stable MCP endpoints

## Security Notes

- OAuth implementation accepts ANY Bearer token by design
- This is NOT a security flaw - it's required for Claude.ai compatibility
- Real security comes from Cloudflare tunnel access control
- Do not expose ports directly to internet

## Maintenance Commands

### Check server status:
```bash
curl -s http://localhost:3017/health
curl -s https://atem-mcp.cochran.cloud/health
```

### Test MCP endpoint:
```bash
curl -X POST https://atem-mcp.cochran.cloud/mcp \
  -H "Authorization: Bearer any-token-works" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

## Contact

If you break this and can't fix it, the stable version is in git history.
Always test changes on a different port before applying to production.