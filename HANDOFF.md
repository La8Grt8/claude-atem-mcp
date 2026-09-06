# ATEM AI Director — Project Handoff

> **Created:** 2026-02-15
> **For:** Continuing development on Linux server with Claude Code CLI
> **Repo:** https://github.com/guycochran/atem-mcp-server.git

---

## Quick Start on Linux

```bash
git clone https://github.com/guycochran/atem-mcp-server.git
cd atem-mcp-server
npm install
npm run build

# You'll need to commit the new files first from the Mac, or copy them:
# - website/index.html (landing page)
# - CLAUDE.md (operator/dev mode instructions)
# - docs/PITCH-DECK.md, docs/PRD.md
# - This file: HANDOFF.md
```

---

## What This Project Is

An MCP server (v1.5.0) that lets Claude control Blackmagic ATEM video switchers via natural language. 62 tools across 8 categories. Works with Claude Desktop (stdio), claude.ai, and Claude Mobile (HTTP/OAuth). Currently connected to an ATEM Mini Extreme ISO at 192.168.8.237.

## What We're Building (v2.0.0)

A full monetization, distribution, and cloud access layer:

1. **Freemium model** — Generous free tier (switching, transitions, recording, basic audio, basic Super Source) + Pro tier (Fairlight EQ, auto-switching, saved looks, advanced routing, macros)
2. **Standalone binary** — No Node.js required. Download one file, run `--setup`, done.
3. **Zero-friction setup wizard** — Auto-discovers ATEMs on the network via UDP broadcast, writes Claude Desktop config automatically
4. **License via LemonSqueezy** — Activate once, works forever on that machine. No periodic checks, no mid-show lockout risk.
5. **Cloud/Mobile access** — Bridge app + hosted MCP server so users can control their ATEM from their phone anywhere in the world
6. **Landing page** — Already built at `website/index.html`

---

## Architecture Overview

### Three-Tier Access Model

```
Tier 1: DESKTOP (Local)
  Claude Desktop → stdio → MCP Server → UDP 9910 → ATEM (LAN)
  Latency: ~2ms to ATEM + 1-2s Claude thinking
  Setup: Download binary, run --setup, done

Tier 2: CLOUD (Hosted on your infrastructure)
  Claude Mobile → HTTPS → Hosted MCP (Coolify) → WebSocket → Bridge (at venue) → UDP 9910 → ATEM
  Latency: 50-200ms bridge + 1-3s Claude thinking
  Setup: Create account, run bridge at venue, paste connector URL in Claude

Tier 3: SELF-HOSTED (Advanced)
  Claude Mobile → HTTPS → User's MCP Server → Cloudflare Tunnel → local ATEM
  Latency: ~2ms + tunnel overhead
  Setup: Install on own server, configure Cloudflare Tunnel
```

### Cloud Architecture (Tier 2) — The Growth Engine

```
[Claude.ai / Mobile]
       |
       | HTTPS (MCP Protocol + OAuth)
       v
[Hosted MCP Server]  <── WebSocket (persistent, outbound) ──  [atem-bridge at venue]
  Coolify / Docker                                                     |
  atemai.xyz/mcp                                                  UDP 9910
       |                                                               |
  [Supabase]                                                       [ATEM]
  - User accounts (Auth)                                        192.168.x.x
  - Bridge tokens
  - OAuth tokens (tenant → bridge routing)
  - Usage tracking
```

**Key design: "Fat Bridge"** — The bridge runs `atem-connection` locally so all timing-sensitive UDP stays on the LAN. The hosted server sends semantic commands (not raw UDP packets) over WebSocket. This means:
- Tolerates seconds of internet latency (you're voice-directing, not riding a fader)
- Low bandwidth (only user commands cross the internet)
- If WebSocket blips, local ATEM connection stays alive

**Why not Cloudflare Tunnel for ATEM?** ATEM uses proprietary UDP on port 9910 with 60ms timeouts and 10ms retransmits. Cloudflare Tunnels are HTTP-only for public endpoints. UDP support requires WARP-to-WARP (same Zero Trust org), which is way too complex for church tech directors.

**Team sharing:** One bridge serves multiple team members. Admin adds connector URL (`atemai.xyz/mcp`) in Claude settings → syncs to iOS/Android/web automatically. On Claude Team plans, admin adds once, members click "Connect."

### Supabase Schema

```sql
create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,           -- "Grace Community Church"
  email text unique not null,
  plan text default 'free',
  created_at timestamptz default now()
);

create table bridges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),
  token text unique not null,
  name text,
  atem_host text,
  atem_model text,
  is_online boolean default false,
  last_seen_at timestamptz,
  created_at timestamptz default now()
);

create table oauth_tokens (
  token text primary key,
  tenant_id uuid references tenants(id),
  bridge_id uuid references bridges(id),
  expires_at timestamptz,
  created_at timestamptz default now()
);

create table usage_log (
  id bigserial primary key,
  tenant_id uuid references tenants(id),
  bridge_id uuid references bridges(id),
  tool_name text,
  timestamp timestamptz default now()
);
```

---

## Current Project Structure

```
atem-mcp-server/
├── src/
│   ├── index.ts                    # Main entry (255 lines) — McpServer, tool registration, stdio/HTTP
│   ├── services/
│   │   ├── atem-connection.ts      # ATEM connection + audio tracking + auto-switch (604 lines)
│   │   └── looks.ts               # Super Source look persistence (~150 lines)
│   └── tools/
│       ├── connection.ts           # connect, disconnect, status, emulator (FREE)
│       ├── switching.ts            # program, preview, cut, auto, FTB (FREE)
│       ├── transitions.ts          # style, rate, position, state (FREE)
│       ├── audio.ts                # set_input, set_master, get_state (FREE)
│       ├── macros-recording.ts     # macros (PRO) + recording/streaming (FREE)
│       ├── routing.ts              # aux, DSK, USK — all PRO
│       ├── fairlight.ts            # EQ, compressor, limiter, gate — all PRO (785 lines)
│       └── supersource.ts          # Mixed: basic=FREE, advanced/looks/auto-switch=PRO (1346 lines)
├── website/
│   └── index.html                  # Landing page (BUILT, ~1700 lines)
├── docs/
│   ├── PRD.md
│   └── PITCH-DECK.md
├── CLAUDE.md                       # Operator/dev mode instructions
├── HANDOFF.md                      # This file
├── package.json                    # v1.5.0, type: module, deps: @mcp/sdk, atem-connection, express, zod
├── tsconfig.json
└── .gitignore
```

---

## Implementation Plan (5 Phases)

The full detailed plan is at the bottom of this file (copied from the plan document). Here's the summary:

### Phase 1: License Service (`src/services/license.ts`)
- LemonSqueezy API integration (activate/validate endpoints)
- Cache at `~/.atem-mcp/license.json`
- `isProLicensed()` — fast in-memory boolean
- Activate once, works forever on that machine

### Phase 2: Tool Gating (`src/services/tool-gate.ts`)
- `withProGate(toolName, description, handler)` wrapper
- Pro tools still registered (discoverable) but execution gated
- Returns friendly upgrade message with feature list

### Phase 3: Setup Wizard (`src/services/discover.ts`)
- UDP broadcast scanner using ATEM HELLO packet on port 9910
- `--setup` CLI: scan → find ATEM → write Claude Desktop config → done
- `--scan` CLI: just list ATEMs (troubleshooting)
- `--activate <key>` CLI: activate Pro license
- Also register `atem_discover` as MCP tool

### Phase 4: Binary Packaging
- `@yao-pkg/pkg` (maintained fork of Vercel's pkg)
- Targets: macOS ARM64, macOS x64, Linux x64, Windows x64
- Handle ESM + native modules (`@julusian/freetype2` prebuilds)

### Phase 5: Cloud Infrastructure (NEW — not in original plan file)
- **Hosted MCP server** on Coolify with Cloudflare
- **Bridge binary** (`atem-bridge`) — fat bridge with local atem-connection
- **Supabase** for accounts, bridge tokens, OAuth routing
- **Dashboard** at atemai.xyz for account/bridge management
- Multi-tenant routing: OAuth token → tenant → bridge → ATEM

---

## Landing Page Status (`website/index.html`)

Already built and updated. Sections:

1. **Hero** — "Your ATEM switcher, directed by voice."
2. **Demo Video** placeholder
3. **Conversation Demo** — Chat-style UI showing real commands
4. **"Two steps. That's it."** — Download + run `--setup` with terminal demo
5. **"Three ways to direct your show"** — Desktop / Mobile-Web (Cloud Beta) / Self-Hosted cards with latency indicators
6. **"Latency: what to expect"** — Real numbers (ATEM ~2ms, Claude 1-3s, Bridge 50-200ms), visual comparison bars, honest "early days" messaging
7. **Features Grid** — 12 cards with FREE/PRO badges
8. **Use Cases** — Houses of Worship, Podcasters, Schools
9. **Pricing** — Free ($0 forever) + Pro ($29/mo or $79 one-time)
10. **Setup Guide** — Accordion: Download → Run setup wizard → Restart Claude → Activate Pro (optional)
11. **FAQ** — 10 entries including bridge, latency, ATEM discovery, cancellation
12. **CTA** — "Ready to direct by voice?"
13. **Footer**

Dark theme, fully responsive, vanilla JS, no dependencies.

---

## Key Technical Details

### ATEM Network Discovery
The `atem-connection` library has NO built-in discovery. We use raw UDP:
- HELLO packet: `Buffer.from([0x10, 0x14, 0x53, 0xab, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3a, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])`
- Send to broadcast addresses on port 9910
- ATEMs respond with protocol handshake containing model info
- Same protocol Blackmagic's ATEM Software Control uses

### LemonSqueezy License API
- Activate: `POST https://api.lemonsqueezy.com/v1/licenses/activate` with `{ license_key, instance_name }`
- Validate: `POST https://api.lemonsqueezy.com/v1/licenses/validate` with `{ license_key }`
- No API key needed (these are public endpoints)
- Returns `license_key.status`, `meta.store_id`, `meta.product_id`
- Hard-code store_id and product_id to verify it's our product

### Tool Registration Pattern
```typescript
// Current pattern in src/index.ts:
export function registerSwitchingTools(server: McpServer, mode: 'basic' | 'full') {
  server.tool("atem_set_program", "Set program input", { input: z.number() }, async (params) => {
    // handler
  });
}

// New Pro gating pattern:
server.tool("atem_fairlight_eq", "Set Fairlight EQ", { ... },
  withProGate("Fairlight EQ", "Professional audio processing", async (params) => {
    // handler - only runs if Pro licensed
  })
);
```

### Current index.ts Startup Flow
```typescript
// Lines 27-53 of src/index.ts:
registerConnectionTools(server);
registerSwitchingTools(server, toolMode);
registerTransitionTools(server, toolMode);
registerAudioTools(server, toolMode);
if (toolMode === 'full') {  // ← This guard gets replaced by Pro gating
  registerRoutingTools(server);
  registerFairlightTools(server);
  registerMacrosRecordingTools(server, toolMode);
  registerSuperSourceTools(server, toolMode);
}
```

### Real Latency Numbers (measured 2026-02-15)
- ATEM LAN (192.168.8.237): avg 2.5ms, max 4ms
- Cloudflare edge (1.1.1.1): avg 5.4ms, max 11ms
- Google (US server): avg 3.9ms, 20% packet loss on small sample

---

## Design Decisions & Rationale

### "Never expire locally"
Production people (churches, live events) cannot risk losing access during a show. Once activated, Pro works forever on that device. No periodic revalidation, no grace periods. Cost to us is $0 infrastructure per customer, so this generosity is free.

### "Fat Bridge" over "Thin Bridge"
The ATEM protocol has 60ms timeouts and 10ms retransmits. Proxying raw UDP packets over the internet would fail under realistic latency. The fat bridge keeps all timing-critical communication local and sends high-level commands over WebSocket, which can tolerate seconds of latency.

### Free/Pro orthogonal to Basic/Full
The existing `basic`/`full` mode split (for mobile context windows vs desktop) stays. Pro gating is independent — a tool can be both "full mode only" (too many tools for mobile) and "free" (no license needed).

### Bridge connects outbound only
Churches have firewalls they can't configure. The bridge initiates an outbound WebSocket connection — no ports need to be opened. Works through any NAT/firewall.

---

## Files NOT in Git (need to copy or commit)

These files exist on the Mac but haven't been committed yet:

```
?? CLAUDE.md              — Operator/dev mode instructions
?? docs/PITCH-DECK.md     — Pitch deck
?? docs/PRD.md            — Product requirements doc
?? tmp-level-monitor.mjs  — Temp debug file (can skip)
?? website/               — Landing page directory
   website/index.html     — Full landing page (~1700 lines)
```

Also modified but not committed:
```
 M README.md
```

### Recommended: Commit and push from Mac first

```bash
cd /Users/guycochranclawdbot/atem-mcp-server
git add CLAUDE.md HANDOFF.md docs/ website/ README.md
git commit -m "Add landing page, handoff docs, and CLAUDE.md for v2.0 development"
git push origin main
```

Then on Linux:
```bash
git pull origin main
npm install
npm run build
```

---

## Infrastructure You Have

- **Linux server** running Coolify (self-hosted PaaS)
- **10gb internet connection**
- **Cloudflare** for DNS/tunnels/CDN
- **Supabase** account
- **Claude Code CLI** on the Linux server
- **LemonSqueezy** account (for payments)
- **Domain:** atemai.xyz (or similar, to be set up)

---

## Implementation Order (Recommended)

### Phase A: Core (local features first)
1. `src/services/discover.ts` — ATEM network scanner
2. `src/services/license.ts` — License activation & caching
3. `src/services/tool-gate.ts` — Pro gating wrapper
4. `src/index.ts` — Wire up: license init, CLI flags, tool registration changes
5. Tool files — Apply `withProGate()` to Pro tools
6. `package.json` — Binary packaging config
7. Build & test

### Phase B: Cloud infrastructure
1. Deploy MCP server to Coolify with Cloudflare
2. Set up Supabase project with schema
3. Add multi-tenant routing to the hosted server
4. Build the bridge binary (`atem-bridge`)
5. Add OAuth flow scoped to tenants
6. Set up atemai.xyz dashboard

### Phase C: Polish
1. Pre-built bridge binaries for all platforms
2. Docker image for bridge
3. Usage tracking
4. Landing page deployment to your domain

---

## Full Plan Document

(The complete plan from `~/.claude/plans/radiant-squishing-wigderson.md` is included above in the "Implementation Plan" section. All details about file changes, new files, tool categorization, and verification steps are there.)
