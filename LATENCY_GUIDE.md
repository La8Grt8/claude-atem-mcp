# ATEM MCP Latency Guide

## Quick Answer: What's the Fastest Setup?

**For lowest latency on local network: Use Claude Desktop with local MCP server**

## Connection Methods & Latency Comparison

### Method 1: LOCAL (Fastest) — Claude Desktop + Local MCP
```
┌─────────────────┐
│ Claude Desktop  │
│ (on your Mac)   │
└────────┬────────┘
         │ stdio (instant)
         ▼
┌─────────────────┐
│  ATEM MCP       │
│  (same Mac)     │
└────────┬────────┘
         │ UDP 9910 (LAN)
         │ ~2-5ms
         ▼
┌─────────────────┐
│     ATEM        │
│ 192.168.x.x     │
└─────────────────┘

Total Latency: 2-5ms + Claude thinking (1-2s)
```

### Method 2: REMOTE — claude.ai + HTTP MCP
```
┌─────────────────┐                    ┌──────────────────┐
│   claude.ai     │                    │  ATEM MCP Server │
│  (browser)      │                    │ (Linux/Docker)   │
└────────┬────────┘                    └────────┬─────────┘
         │                                      │
         │ HTTPS + OAuth                        │ UDP 9910 (LAN)
         │ via Internet                         │ ~2-5ms
         │ ~50-200ms                            ▼
         │                             ┌─────────────────┐
         └────────────────────────────►│     ATEM        │
                                       │ 192.168.x.x     │
                                       └─────────────────┘

Total Latency: 50-200ms + Claude thinking (1-3s)
```

### Method 3: HYBRID — Claude Desktop + Remote MCP
```
┌─────────────────┐                    ┌──────────────────┐
│ Claude Desktop  │                    │  ATEM MCP Server │
│ (on your Mac)   │                    │ (remote server)  │
└────────┬────────┘                    └────────┬─────────┘
         │                                      │
         │ HTTPS + OAuth                        │ UDP 9910
         │ via Internet                         │ (may need VPN)
         │ ~50-200ms                            │ ~10-50ms
         │                                      ▼
         └──────────────────────────────────────┘

Total Latency: 60-250ms + Claude thinking (1-2s)
```

### Method 4: FUTURE BRIDGE — Cloud MCP + Local Bridge (In Development)
```
┌─────────────────┐      ┌─────────────────┐      ┌──────────────┐
│ Claude Mobile/  │      │ Hosted MCP      │      │ ATEM Bridge  │
│ claude.ai       │─────►│ (atemai.xyz)    │─────►│ (at venue)   │
└─────────────────┘      └─────────────────┘      └──────┬───────┘
    HTTPS/OAuth              WebSocket                    │
    ~50-200ms               (semantic cmds)               │ UDP 9910
                            tolerates latency             │ ~2-5ms
                                                          ▼
                                                 ┌─────────────────┐
                                                 │     ATEM        │
                                                 │ 192.168.x.x     │
                                                 └─────────────────┘

Total Latency: 50-200ms + Claude thinking (1-3s)
Bridge Advantage: ATEM protocol timeouts (60ms) stay local
```

## Latency Breakdown

### Network Components
- **ATEM Protocol (UDP 9910)**: 2-5ms on LAN
- **Internet Round Trip**: 50-200ms (varies by location)
- **Cloudflare Tunnel**: +5-20ms overhead
- **stdio (local)**: ~0ms (same process)

### Claude Processing
- **Claude thinking time**: 1-3 seconds (dominates total time)
- **Tool execution**: 10-50ms
- **OAuth handshake**: One-time 500ms-2s

## Why ATEM Protocol Must Stay Local

From the HANDOFF.md documentation:
> "The ATEM protocol has 60ms timeouts and 10ms retransmits. Proxying raw UDP packets over the internet would fail under realistic latency."

This is why:
1. **Direct remote ATEM connection fails** — Protocol timeouts too aggressive
2. **Bridge architecture works** — Keeps timing-critical UDP local
3. **Cloudflare Tunnel alone won't work** — HTTP-only, no UDP support

## Recommendations by Use Case

### Live Production (Lowest Latency Required)
✅ **Best**: Claude Desktop + Local MCP server on same network as ATEM
- Total delay: 2-5ms + Claude thinking (1-2s)
- Commands execute instantly after Claude responds

### Remote Production (Acceptable Latency)
✅ **Good**: claude.ai + HTTP MCP server at venue
- Total delay: 50-200ms + Claude thinking (1-3s)
- Works from anywhere with internet
- Use if you have a server at the venue

### Mobile Control (Coming Soon)
✅ **Future**: Claude Mobile + Bridge at venue
- Total delay: 50-200ms + Claude thinking (1-3s)
- No server setup required
- Bridge handles protocol timeouts locally

### What NOT to Do
❌ **Don't**: Try to connect ATEM directly over internet
- ATEM protocol will timeout and fail
- Even VPN adds too much latency for reliable connection

## Setup Instructions for Fastest (Local) Connection

1. **Install on same network as ATEM**:
   ```bash
   cd /path/to/atem-mcp-server
   npm install
   npm run build
   ```

2. **Configure Claude Desktop**:
   ```json
   {
     "mcpServers": {
       "atem": {
         "command": "/usr/local/bin/node",
         "args": ["/path/to/atem-mcp-server/dist/index.js"],
         "env": {
           "ATEM_HOST": "192.168.x.x"  // Your ATEM IP
         }
       }
     }
   }
   ```

3. **Restart Claude Desktop**
   - Commands execute with only 2-5ms network latency
   - Claude thinking time (1-2s) is the only noticeable delay

## Summary

- **Fastest**: Local Claude Desktop → Local MCP → ATEM (2-5ms)
- **Remote**: claude.ai → HTTP MCP → ATEM (50-200ms)
- **Claude thinking**: 1-3s (dominates total time regardless of setup)
- **Key insight**: Network latency is tiny compared to Claude's thinking time
- **Critical**: ATEM protocol requires <60ms latency, so must stay on LAN