# MCP Server Security Implementation

## Overview

This MCP server implements **proper OAuth 2.0 authentication** with JWT token validation. Unlike the previous "accept any token" approach, this implementation provides:

✅ Real JWT token validation with expiration
✅ Client credential verification
✅ Authorization code flow with one-time use codes
✅ Refresh token support
✅ Token revocation capability
✅ Comprehensive audit logging
✅ Automatic token cleanup

## Architecture

```
Claude.ai → OAuth Discovery → Client Registration → Authorization Code → Token Exchange → JWT Validation → MCP Request
```

### Security Components

1. **JWT Tokens**: Signed with secret, expire in 24 hours
2. **Refresh Tokens**: Random 32-byte strings, expire in 7 days
3. **Authorization Codes**: One-time use, expire in 5 minutes
4. **Client Secrets**: UUID-based, validated on token exchange
5. **Audit Logging**: Every request logged with client ID and tool name

## Configuration

### Environment Variables

```bash
# Required
TRANSPORT=http
PORT=3017
BASE_URL=https://atem-mcp.cochran.cloud  # CRITICAL for OAuth!

# Optional - JWT Secret (auto-generated if not provided)
JWT_SECRET=your-secret-key-here  # 64-byte hex recommended
```

### Generate a Secure JWT Secret

```bash
# Generate a random 64-byte secret
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

**For production**: Set `JWT_SECRET` in environment to persist across restarts.

## OAuth Flow (Claude.ai)

### 1. Discovery
Claude.ai fetches:
- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/oauth-protected-resource/mcp`

### 2. Client Registration
```http
POST /register
{
  "client_name": "Claude",
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"]
}
```

Response includes `client_id` and `client_secret` (stored by server).

### 3. Authorization
```http
GET /authorize?client_id=xxx&redirect_uri=xxx&state=xxx
```

Server generates 5-minute authorization code and redirects to Claude.

### 4. Token Exchange
```http
POST /token
{
  "grant_type": "authorization_code",
  "code": "xxx",
  "client_id": "xxx",
  "client_secret": "xxx"
}
```

Server validates:
- ✓ Authorization code exists and matches client
- ✓ Code hasn't expired (5 min)
- ✓ Client credentials are correct
- ✓ Code hasn't been used (one-time use)

Returns JWT access token + refresh token.

### 5. MCP Request
```http
POST /mcp
Authorization: Bearer <JWT>
```

Server validates:
- ✓ JWT signature is valid
- ✓ Token hasn't expired
- ✓ Token hasn't been revoked
- ✓ Updates usage statistics

## Security Features

### JWT Token Structure
```json
{
  "sub": "client-id",
  "scope": "mcp:tools",
  "iat": 1234567890,
  "exp": 1234654290
}
```

Signed with HS256 using `JWT_SECRET`.

### Audit Logging

Every MCP request logs:
```
[AUDIT] 2026-04-08T12:34:56.789Z | client=abc123 | method=tools/call | tool=cut_to_input
```

**Use cases:**
- Track who did what and when
- Identify suspicious patterns
- Debug integration issues
- Compliance/forensics

### Token Lifecycle

| State | Lifetime | Cleanup |
|-------|----------|---------|
| Authorization Code | 5 minutes | Immediate after use or expiry |
| Access Token (JWT) | 24 hours | Auto-cleanup every 15 min |
| Refresh Token | 7 days | Auto-cleanup every 15 min |

### Token Revocation

```javascript
// Revoke single token
tokenManager.revokeToken(accessToken);

// Revoke all tokens for a client
tokenManager.revokeClientTokens(clientId);
```

**When to revoke:**
- User logs out
- Security incident detected
- Client deactivated
- Suspicious activity

## Additional Security Layers

### Recommended: Cloudflare Access

Add Cloudflare Access in front of your tunnel for:
- ✅ SSO authentication (Google, GitHub, etc.)
- ✅ IP whitelisting
- ✅ Device posture checks
- ✅ Session recording

**Setup:**
1. Go to Cloudflare Zero Trust dashboard
2. Create Access Policy for `atem-mcp.cochran.cloud`
3. Add allowed users/groups
4. Enable "Require WARP" for extra security

### Network Security

```bash
# Cloudflare Tunnel (current)
cloudflared tunnel --config ~/.cloudflared/atem-mcp-3017-config.yml run

# Firewall rules (recommended)
sudo ufw allow from 192.168.0.0/16 to any port 3017  # LAN only
sudo ufw deny 3017  # Block public access to raw port
```

## Migration from "Accept Any Token"

### What Changed

**Before:**
```typescript
// Accept ANY bearer token (don't validate — just log)
console.error(`[AUTH] ✓ Bearer ${token.substring(0, 8)}... known=${validTokens.has(token)}`);
```

**After:**
```typescript
// Validate JWT token
const validation = tokenManager.validateToken(token);
if (!validation.valid) {
  res.status(401).json({ error: 'Invalid or expired token' });
  return;
}
```

### Breaking Changes

❌ Random Bearer tokens no longer work
✅ Only valid JWTs issued by this server work

### Client Impact

**Claude.ai**: No changes needed - OAuth flow handles everything
**Custom clients**: Must complete OAuth flow to get valid tokens

## Monitoring

### Health Check
```bash
curl https://atem-mcp.cochran.cloud/health
```

### Token Statistics
```typescript
const stats = tokenManager.getStats();
console.log(stats);
// { activeTokens: 5, activeClients: 3, totalRequests: 142 }
```

### Logs to Watch

```
[AUTH] ✓ Valid token for <client> (used X times)  # Good
[AUTH] ✗ Invalid token signature                   # Attack attempt
[AUTH] ✗ Token expired                             # Normal (refresh needed)
[AUTH] ✗ Unknown client                            # Registration needed
[AUDIT] <timestamp> | client=<id> | tool=<name>   # Every action
```

## Testing

### Test OAuth Flow
```bash
# 1. Get discovery endpoints
curl https://atem-mcp.cochran.cloud/.well-known/oauth-authorization-server | jq

# 2. Register client
curl -X POST https://atem-mcp.cochran.cloud/register \
  -H "Content-Type: application/json" \
  -d '{"client_name":"test"}' | jq

# 3. Get authorization code (use browser)
https://atem-mcp.cochran.cloud/authorize?client_id=<id>&redirect_uri=http://localhost

# 4. Exchange code for token
curl -X POST https://atem-mcp.cochran.cloud/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type":"authorization_code",
    "code":"<code>",
    "client_id":"<id>",
    "client_secret":"<secret>"
  }' | jq

# 5. Test MCP endpoint
curl -X POST https://atem-mcp.cochran.cloud/mcp \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' | jq
```

### Verify Security

```bash
# Should FAIL - invalid token
curl -X POST https://atem-mcp.cochran.cloud/mcp \
  -H "Authorization: Bearer fake-token" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'

# Should return 401 Unauthorized
```

## FAQ

### Q: Do I need to change my Claude.ai MCP config?

**A:** No! Claude.ai automatically handles the OAuth flow. Just use:
```json
{
  "atem": {
    "url": "https://atem-mcp.cochran.cloud/"
  }
}
```

### Q: What if JWT_SECRET changes?

**A:** All existing tokens become invalid. Clients must re-authenticate via OAuth.

### Q: Can I use this with Claude Desktop (stdio)?

**A:** Yes! Stdio transport doesn't use OAuth - it's direct process communication. This security applies only to HTTP transport.

### Q: How do I rotate secrets?

```bash
# 1. Generate new secret
NEW_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")

# 2. Update environment
export JWT_SECRET=$NEW_SECRET

# 3. Restart server
pm2 restart atem-mcp

# 4. All clients must re-authenticate
```

### Q: What about rate limiting?

This implementation includes usage tracking (`requestCount`) but not rate limiting. Consider adding:

```typescript
if (stored.requestCount > 100) {  // 100 requests per token
  res.status(429).json({ error: 'Rate limit exceeded' });
  return;
}
```

## Support

- **Issues**: GitHub Issues
- **Security**: Email security concerns privately
- **Docs**: See ARCHITECTURE.md for technical details

---

**Last Updated**: April 8, 2026
**Version**: 1.5.0 (secure)
**Status**: ✅ Production Ready
