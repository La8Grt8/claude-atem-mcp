# ATEM MCP Server Recovery Guide

## Quick Fix for "Broken" ATEM MCP

The ATEM MCP server now requires authentication via Bearer token. This is a security feature to prevent unauthorized access.

### Option 1: Disable Authentication (Quick Fix)

1. Set environment variable to disable auth:
```bash
TRANSPORT=http PORT=3017 AUTH=none npm start
```

### Option 2: Use with Claude/Production Bots (Proper Fix)

The server expects requests from Claude with proper authentication headers. When using with:
- Claude Desktop: It handles auth automatically
- Production Bots Dashboard: Add your Anthropic API key
- Direct API calls: Include Bearer token

### Option 3: Revert to Previous Version

If you need the old behavior:
```bash
# Show available versions
git log --oneline | grep -E "Add|Fix|Update" | head -20

# Revert to a specific commit
git checkout <commit-hash>

# Or create a branch from working version
git checkout -b stable-version <commit-hash>
```

## Preventing Future Breaks

### 1. Always Keep Backups

```bash
# Before any major changes
git add -A
git commit -m "Backup before changes"
git push

# Tag stable versions
git tag -a v1.0-stable -m "Stable production version"
git push --tags
```

### 2. Test in Development First

```bash
# Use different ports for testing
TRANSPORT=http PORT=3018 npm start  # Test instance
TRANSPORT=http PORT=3017 npm start  # Production
```

### 3. Create Configuration Profiles

```bash
# Create start scripts
echo 'TRANSPORT=http PORT=3017 AUTH=none npm start' > start-no-auth.sh
echo 'TRANSPORT=http PORT=3017 npm start' > start-with-auth.sh
chmod +x start-*.sh
```

### 4. Document Working Configurations

Keep a file with known working configurations:
```bash
# working-config.txt
Working as of 2026-03-01:
- Node version: 18+
- ATEM Connection: 3.8.0
- Start command: TRANSPORT=http PORT=3017 AUTH=none npm start
- ATEM IP: 192.168.6.136
```

## Emergency Recovery Steps

If completely broken:

1. **Kill all processes:**
```bash
pkill -f "node.*atem"
```

2. **Clear node modules and rebuild:**
```bash
rm -rf node_modules package-lock.json
npm install
npm run build
```

3. **Start with minimal config:**
```bash
TRANSPORT=http PORT=3017 AUTH=none npm start
```

4. **Test basic connectivity:**
```bash
curl -X POST http://localhost:3017/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

## Backup Strategy

1. **Regular Git Commits:**
   - Commit working configurations immediately
   - Use descriptive commit messages
   - Push to remote regularly

2. **Version Tags:**
   ```bash
   git tag -a production-stable -m "Production stable version"
   git push --tags
   ```

3. **Config Snapshots:**
   ```bash
   # Save current working state
   cp -r . ../atem-mcp-backup-$(date +%Y%m%d)
   ```

4. **Environment Documentation:**
   - Keep .env.example with working values
   - Document all required environment variables
   - Note specific version dependencies

## Testing Checklist

Before declaring "broken":
- [ ] Check if server is actually running: `ps aux | grep atem`
- [ ] Check correct port: `lsof -i :3017`
- [ ] Try without auth: `AUTH=none npm start`
- [ ] Check ATEM connection: Is ATEM powered on and network accessible?
- [ ] Review recent changes: `git log --oneline -10`

Remember: The MCP protocol expects specific authentication. What seems "broken" might just be proper security working as intended!