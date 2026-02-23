# Claude Desktop MCP Connection Issue & Workaround

## Problem
The ATEM MCP server uses OAuth 2.0 authentication, but Claude Desktop's MCP client doesn't properly handle the OAuth flow, resulting in a "missing redirect_uri" error.

## Current Status
- Server is running at https://atem-mcp.cochran.cloud/mcp
- OAuth endpoints are properly configured
- The issue is with Claude Desktop not sending required OAuth parameters

## Workaround Options

### Option 1: Use Direct API Key (Recommended for now)
Instead of using Claude Desktop's MCP feature, use the ATEM MCP server directly via API:

```javascript
// In your application, use the Anthropic API directly
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": "YOUR-ANTHROPIC-API-KEY"
  },
  body: JSON.stringify({
    model: "claude-3-sonnet-20240229",
    messages: [{
      role: "user",
      content: "Switch to camera 2"
    }],
    tools: [{
      type: "computer_20241022",
      mcp_servers: {
        "atem": {
          url: "https://atem-mcp.cochran.cloud/mcp",
          transport: "http"
        }
      }
    }]
  })
});
```

### Option 2: Local Stdio Mode
Run the server locally in stdio mode (no OAuth required):

```bash
cd /home/guycochran/atem-mcp-server
TRANSPORT=stdio ATEM_HOST=192.168.8.237 node dist/index.js
```

Then configure Claude Desktop to use stdio transport instead of HTTP.

### Option 3: Wait for Claude Desktop Update
The Claude Desktop team is aware of OAuth implementation issues with MCP servers. A future update should resolve this.

## Server Configuration
The server accepts ANY bearer token once OAuth flow is completed. The issue is getting through the initial OAuth handshake.

## Technical Details
- Error: `{"error":"missing redirect_uri"}`
- Occurs at: `/authorize` endpoint
- Root cause: Claude Desktop MCP client doesn't include redirect_uri in OAuth authorization request

## For Developers
If you need to modify the authentication behavior, the relevant code is in:
- `src/index.ts` lines 156-166 (authorize endpoint)
- `src/index.ts` lines 204-212 (MCP endpoint auth check)

The server is designed to be permissive - it accepts any bearer token and doesn't validate credentials, but still requires the OAuth flow for security compliance.