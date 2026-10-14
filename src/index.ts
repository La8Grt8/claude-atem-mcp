// IMPORTANT: Redirect console.log to stderr so stdout stays clean for MCP JSON-RPC.
console.log = console.error;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { connectAtem, waitForConnection, getAtem, isAtemConnected, getActiveInputsByAudioLevel, isLevelTrackingActive, getAutoSwitchStatus, getAudioLevelsSnapshot, startAudioLevelTracking } from './services/atem-connection.js';
import { Enums } from 'atem-connection';
import { registerConnectionTools } from './tools/connection.js';
import { registerSwitchingTools } from './tools/switching.js';
import { registerTransitionTools } from './tools/transitions.js';
import { registerRoutingTools } from './tools/routing.js';
import { registerMacroTools, registerRecordingStreamingTools } from './tools/macros-recording.js';
import { registerAudioTools } from './tools/audio.js';
import { registerSuperSourceTools, PRESETS } from './tools/supersource.js';
import { registerFairlightTools, EQ_PRESETS } from './tools/fairlight.js';
import { registerEdlTools } from './tools/edl.js';
import { tokenManager } from './auth/token-manager.js';

const toolMode: 'basic' | 'full' = process.env.TOOLS === 'basic' ? 'basic' : 'full';

function createServer(): McpServer {
  const server = new McpServer({ name: 'atem-mcp-server', version: '1.5.0' });

  // Always registered (basic + full)
  registerConnectionTools(server);          // 3 tools
  registerSwitchingTools(server);           // 6 tools
  registerTransitionTools(server, toolMode);// basic: 2, full: 4
  registerRecordingStreamingTools(server);  // 5 tools
  registerSuperSourceTools(server, toolMode);// basic: 7, full: 14
  registerEdlTools(server);                 // 4 tools (EDL logging for Resolve)

  // Full-only tool groups
  if (toolMode === 'full') {
    registerRoutingTools(server);           // 11 tools
    registerMacroTools(server, toolMode);   // 4 tools
    registerAudioTools(server);             // 3 tools
    registerFairlightTools(server);         // 12 tools
  }

  return server;
}

function autoConnect(): void {
  const host = process.env.ATEM_HOST;
  if (host) {
    const port = process.env.ATEM_PORT ? parseInt(process.env.ATEM_PORT) : undefined;
    connectAtem(host, port)
      .then((msg: string) => console.error(`[atem-mcp] Auto-connected: ${msg}`))
      .catch((err: Error) => console.error(`[atem-mcp] Auto-connect failed: ${err}`));
  }
}

async function runStdio(): Promise<void> {
  const server = createServer();
  autoConnect();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[atem-mcp] ATEM MCP Server running on stdio | tools: ${toolMode}`);
}

async function runHTTP(): Promise<void> {
  const app = express();
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || '3000'}`;

  const httpServer = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    console.error(`[REQ] ${req.method} ${req.url?.split('?')[0]} auth=${req.headers.authorization ? req.headers.authorization.substring(0, 25) + '...' : 'none'}`);

    // Fix Accept header for POST /mcp at raw level
    if (req.method === 'POST' && (req.url === '/mcp' || req.url?.startsWith('/mcp?'))) {
      const accept = req.headers.accept || '';
      if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
        req.headers.accept = 'application/json, text/event-stream';
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          if (req.rawHeaders[i].toLowerCase() === 'accept') {
            req.rawHeaders[i + 1] = 'application/json, text/event-stream';
            break;
          }
        }
        console.error(`[FIX] Accept → application/json, text/event-stream`);
      }
    }

    // Response logging
    const origEnd = res.end.bind(res);
    const chunks: Buffer[] = [];
    const origWrite = res.write.bind(res);
    res.write = function(chunk: any, ...args: any[]): boolean {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return origWrite(chunk, ...args);
    } as any;
    res.end = function(chunk: any, ...args: any[]): any {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8').substring(0, 300);
      console.error(`[RESP] ${req.method} ${req.url?.split('?')[0]} => ${res.statusCode} body=${body}`);
      return origEnd(chunk, ...args);
    } as any;

    app(req, res);
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // ── CORS ──
  app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, HEAD, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
    res.header('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version');
    next();
  });
  app.options('*', (_req: express.Request, res: express.Response) => { res.sendStatus(204); });

  // ══════════════════════════════════════════════════════════════════════════
  // OAuth 2.0
  // ══════════════════════════════════════════════════════════════════════════

  app.get('/.well-known/oauth-protected-resource/mcp', (_req: express.Request, res: express.Response) => {
    res.json({ resource: `${baseUrl}/mcp`, authorization_servers: [baseUrl], bearer_methods_supported: ['header'] });
  });
  app.get('/.well-known/oauth-protected-resource', (_req: express.Request, res: express.Response) => {
    res.json({ resource: baseUrl, authorization_servers: [baseUrl], bearer_methods_supported: ['header'] });
  });
  app.get('/.well-known/oauth-authorization-server', (_req: express.Request, res: express.Response) => {
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp:tools']
    });
  });

  // Dynamic registration — generate credentials and store client
  app.post('/register', (req: express.Request, res: express.Response) => {
    const clientId = req.body?.client_id || crypto.randomUUID();
    const clientSecret = req.body?.client_secret || crypto.randomUUID();
    const clientName = req.body?.client_name || 'Claude';
    const redirectUris = req.body?.redirect_uris || [];

    // Register client with token manager
    tokenManager.registerClient(clientId, clientSecret, clientName, redirectUris);

    res.status(201).json({
      client_id: clientId,
      client_secret: clientSecret,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: req.body?.grant_types || ['authorization_code', 'refresh_token'],
      response_types: req.body?.response_types || ['code'],
      token_endpoint_auth_method: req.body?.token_endpoint_auth_method || 'client_secret_post',
      scope: req.body?.scope || 'mcp:tools'
    });
  });

  app.get('/authorize', (req: express.Request, res: express.Response) => {
    const redirectUri = req.query.redirect_uri as string;
    const clientId = req.query.client_id as string;
    const state = req.query.state as string;

    if (!redirectUri) {
      res.status(400).json({ error: 'missing redirect_uri' });
      return;
    }

    if (!clientId) {
      res.status(400).json({ error: 'missing client_id' });
      return;
    }

    // Generate authorization code
    const code = tokenManager.createAuthorizationCode(clientId, redirectUri);
    console.error(`[OAUTH] authorize → code=${code.substring(0, 8)}... client=${clientId}`);

    const url = new URL(redirectUri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    res.redirect(302, url.toString());
  });

  // Token endpoint — validate credentials and issue JWT
  app.post('/token', (req: express.Request, res: express.Response) => {
    const grantType = req.body?.grant_type;
    const clientId = req.body?.client_id;
    const clientSecret = req.body?.client_secret;
    const code = req.body?.code;
    const refreshTokenParam = req.body?.refresh_token;

    console.error(`[OAUTH] token: grant=${grantType} client_id=${clientId}`);

    // Handle authorization_code grant
    if (grantType === 'authorization_code') {
      if (!code || !clientId || !clientSecret) {
        console.error(`[OAUTH] ✗ Missing required parameters`);
        res.status(400).json({ error: 'invalid_request', error_description: 'Missing code, client_id, or client_secret' });
        return;
      }

      // Validate authorization code
      const codeValidation = tokenManager.validateAuthorizationCode(code, clientId);
      if (!codeValidation.valid) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
        return;
      }

      // Validate client credentials
      if (!tokenManager.validateClient(clientId, clientSecret)) {
        res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
        return;
      }

      // Issue JWT token
      const { accessToken, refreshToken } = tokenManager.issueToken(clientId, 'mcp:tools');

      res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 86400, // 24 hours
        refresh_token: refreshToken,
        scope: 'mcp:tools'
      });
      return;
    }

    // Handle refresh_token grant
    if (grantType === 'refresh_token') {
      if (!refreshTokenParam) {
        res.status(400).json({ error: 'invalid_request', error_description: 'Missing refresh_token' });
        return;
      }

      const result = tokenManager.refreshAccessToken(refreshTokenParam);
      if (result.error) {
        res.status(400).json({ error: 'invalid_grant', error_description: result.error });
        return;
      }

      res.json({
        access_token: result.accessToken,
        token_type: 'Bearer',
        expires_in: 86400,
        scope: 'mcp:tools'
      });
      return;
    }

    // Unsupported grant type
    res.status(400).json({ error: 'unsupported_grant_type' });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // MCP endpoints — require Bearer token
  // ══════════════════════════════════════════════════════════════════════════

  app.head('/mcp', (_req: express.Request, res: express.Response) => {
    res.setHeader('MCP-Protocol-Version', '2025-03-26');
    res.setHeader('Content-Type', 'application/json');
    res.sendStatus(200);
  });

  app.get('/health', (_req: express.Request, res: express.Response) => {
    res.json({ status: 'ok', server: 'atem-mcp-server', version: '1.5.0' });
  });

  // ---- REST state API (prodbots dashboard) — instant switching, no LLM ----
  const restSwitch = (fn: (atem: ReturnType<typeof getAtem>, input: number) => Promise<unknown>) =>
    async (req: express.Request, res: express.Response) => {
      try {
        await waitForConnection(5000);
        const input = parseInt(String(req.body?.input ?? '0'));
        await fn(getAtem(), input);
        res.json({ ok: true });
      } catch (error) {
        res.status(502).json({ error: String(error) });
      }
    };

  app.get('/state/switcher', async (_req: express.Request, res: express.Response) => {
    try {
      await waitForConnection(5000);
      const state = getAtem().state;
      const me = (state?.video?.mixEffects?.[0] ?? {}) as {
        programInput?: number; previewInput?: number;
        fadeToBlack?: { isFullyBlack: boolean; inTransition: boolean };
      };
      const ftb = me.fadeToBlack
        ? { isFullyBlack: me.fadeToBlack.isFullyBlack, inTransition: me.fadeToBlack.inTransition }
        : null;
      const auxSource = state?.video?.auxilliaries?.[0];
      const aux = typeof auxSource === 'number' ? auxSource : null;
      res.json({
        connected: isAtemConnected(),
        program: me.programInput ?? null,
        preview: me.previewInput ?? null,
        ftb,
        aux,
      });
    } catch (error) {
      res.status(502).json({ error: String(error) });
    }
  });
  // Auto-switch status (for dashboard sync — server is the source of truth so
  // the "Manual Control" banner and AUTO SWITCH section self-correct no matter
  // where auto-switch was started/stopped, e.g. from another tab or voice command).
  app.get('/state/auto-switch', async (_req: express.Request, res: express.Response) => {
    try {
      res.json(getAutoSwitchStatus());
    } catch (error) {
      res.status(502).json({ error: String(error) });
    }
  });

  // Fairlight audio meter levels for inputs 1-8 (for dashboard meter UI).
  // Kicks off level tracking if it isn't already active so meters self-start.
  app.get('/state/audio-levels', async (_req: express.Request, res: express.Response) => {
    try {
      await waitForConnection(5000);
      if (!isLevelTrackingActive()) {
        startAudioLevelTracking().catch((e) => console.error('[atem-mcp] Level tracking start failed:', e));
      }
      res.json(getAudioLevelsSnapshot());
    } catch (error) {
      res.status(502).json({ error: String(error) });
    }
  });

  // Server-Sent Events stream of the same snapshot shape as GET /state/audio-levels,
  // pushed at ~10Hz so meter ballistics can react to transients between polls.
  // GET /state/audio-levels above remains as a fallback for clients that can't use SSE.
  const MAX_SSE_CLIENTS = 20;
  let sseClientCount = 0;
  const AUDIO_LEVELS_SSE_TICK_MS = 100;

  app.get('/state/audio-levels/stream', async (req: express.Request, res: express.Response) => {
    if (sseClientCount >= MAX_SSE_CLIENTS) {
      res.status(503).json({ error: 'too many concurrent audio-level streams' });
      return;
    }

    try {
      await waitForConnection(5000);
    } catch (error) {
      res.status(502).json({ error: String(error) });
      return;
    }

    if (!isLevelTrackingActive()) {
      startAudioLevelTracking().catch((e) => console.error('[atem-mcp] Level tracking start failed:', e));
    }

    sseClientCount++;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.flushHeaders();

    const send = () => {
      res.write(`data: ${JSON.stringify(getAudioLevelsSnapshot())}\n\n`);
    };

    send(); // send an initial snapshot immediately so the UI doesn't wait a full tick
    const interval = setInterval(send, AUDIO_LEVELS_SSE_TICK_MS);

    const cleanup = () => {
      clearInterval(interval);
      sseClientCount--;
    };
    req.on('close', cleanup);
    res.on('error', cleanup);
  });

  app.post('/state/program', restSwitch((atem, input) => atem.changeProgramInput(input, 0)));
  app.post('/state/preview', restSwitch((atem, input) => atem.changePreviewInput(input, 0)));
  app.post('/state/cut', restSwitch((atem) => atem.cut(0)));
  app.post('/state/auto', restSwitch((atem) => atem.autoTransition(0)));

  // Fade to black toggle (no LLM) — no body needed.
  app.post('/state/ftb', async (_req: express.Request, res: express.Response) => {
    try {
      await waitForConnection(5000);
      const atem = getAtem();
      await atem.fadeToBlack(0);
      res.json({ ok: true });
    } catch (error) {
      res.status(502).json({ error: String(error) });
    }
  });

  // Aux (HDMI output / bus 0) source select (no LLM) — body: { source: number }
  app.post('/state/aux', async (req: express.Request, res: express.Response) => {
    try {
      await waitForConnection(5000);
      const atem = getAtem();
      const source = Number(req.body?.source);
      if (!Number.isFinite(source)) { res.status(400).json({ error: 'source (number) required' }); return; }
      await atem.setAuxSource(source, 0);
      res.json({ ok: true, source });
    } catch (error) {
      res.status(502).json({ error: String(error) });
    }
  });

  // Ensure Fairlight audio is ON for inputs 1-8 so the ATEM reports levels
  // (active-speaker detection needs this — OFF inputs report silence).
  // Called by the dashboard's Active Speaker button and Reset.
  app.post('/state/audio-on', async (req: express.Request, res: express.Response) => {
    try {
      await waitForConnection(5000);
      const atem = getAtem();
      const done: number[] = [];
      for (let input = 1; input <= 8; input++) {
        const src = atem.state?.fairlight?.inputs?.[input]?.sources;
        const sourceId = src ? Object.keys(src)[0] : null;
        if (sourceId) {
          await atem.setFairlightAudioMixerSourceProps(input, sourceId, {
            mixOption: Enums.FairlightAudioMixOption.On
          } as any);
          done.push(input);
        }
      }
      res.json({ ok: true, audioOn: done });
    } catch (error) {
      res.status(502).json({ error: String(error) });
    }
  });

  // Direct Fairlight fader control (no LLM) — body: { input, faderGain }
  // input 1-8, faderGain in dB (-100..+10). input 0 = master output.
  // Used by the dashboard's Audio panel so faders are instant + free.
  app.post('/state/audio-fader', async (req: express.Request, res: express.Response) => {
    try {
      await waitForConnection(5000);
      const atem = getAtem();
      const input = Number(req.body?.input);
      const faderGain = Number(req.body?.faderGain);
      if (!Number.isFinite(faderGain)) { res.status(400).json({ error: 'faderGain (dB) required' }); return; }
      const native = Math.round(faderGain * 100); // dbToFairlight
      if (input === 0) {
        await atem.setFairlightAudioMixerMasterProps({ faderGain: native } as any);
        res.json({ ok: true, master: faderGain });
        return;
      }
      const src = atem.state?.fairlight?.inputs?.[input]?.sources;
      const sourceId = src ? Object.keys(src)[0] : null;
      if (!sourceId) { res.status(404).json({ error: `input ${input} not found` }); return; }
      await atem.setFairlightAudioMixerSourceProps(input, sourceId, { faderGain: native } as any);
      res.json({ ok: true, input, faderGain });
    } catch (error) {
      res.status(502).json({ error: String(error) });
    }
  });

  // Direct Fairlight mix on/off (no LLM) — body: { input, on }
  app.post('/state/audio-mix', async (req: express.Request, res: express.Response) => {
    try {
      await waitForConnection(5000);
      const atem = getAtem();
      const input = Number(req.body?.input);
      const on = !!req.body?.on;
      const src = atem.state?.fairlight?.inputs?.[input]?.sources;
      const sourceId = src ? Object.keys(src)[0] : null;
      if (!sourceId) { res.status(404).json({ error: `input ${input} not found` }); return; }
      await atem.setFairlightAudioMixerSourceProps(input, sourceId, {
        mixOption: on ? Enums.FairlightAudioMixOption.On : Enums.FairlightAudioMixOption.Off
      } as any);
      res.json({ ok: true, input, on });
    } catch (error) {
      res.status(502).json({ error: String(error) });
    }
  });

  // Direct Fairlight EQ preset (no LLM) — body: { input, preset }
  // Reuses the exact EQ_PRESETS band tables from the MCP tool.
  app.post('/state/audio-eq', async (req: express.Request, res: express.Response) => {
    try {
      await waitForConnection(5000);
      const atem = getAtem();
      const input = Number(req.body?.input);
      const preset = String(req.body?.preset || '');
      const p = EQ_PRESETS[preset];
      if (!p) { res.status(400).json({ error: `unknown preset; available: ${Object.keys(EQ_PRESETS).join(', ')}` }); return; }
      const src = atem.state?.fairlight?.inputs?.[input]?.sources;
      const sourceId = src ? Object.keys(src)[0] : null;
      if (!sourceId) { res.status(404).json({ error: `input ${input} not found` }); return; }
      for (let i = 0; i < p.bands.length; i++) {
        const b = p.bands[i];
        await atem.setFairlightAudioMixerSourceEqualizerBandProps(input, sourceId, i, {
          bandEnabled: b.bandEnabled, shape: b.shape, frequency: b.frequency,
          gain: b.gain, qFactor: b.qFactor, frequencyRange: b.frequencyRange,
        } as any);
      }
      res.json({ ok: true, input, preset });
    } catch (error) {
      res.status(502).json({ error: String(error) });
    }
  });

  // One-shot cut to the current active speaker (no LLM, no ongoing mode) —
  // body: { transition: 'cut'|'auto' }. Ensures input audio is on first so
  // levels are reported, then cuts to the loudest guest right now.
  app.post('/state/cut-to-speaker', async (req: express.Request, res: express.Response) => {
    try {
      await waitForConnection(5000);
      const atem = getAtem();
      const transition = String(req.body?.transition || 'cut');
      // ensure Fairlight audio is on so levels are reported
      try {
        for (let input = 1; input <= 8; input++) {
          const src = atem.state?.fairlight?.inputs?.[input]?.sources;
          const sid = src ? Object.keys(src)[0] : null;
          if (sid) await atem.setFairlightAudioMixerSourceProps(input, sid, { mixOption: Enums.FairlightAudioMixOption.On } as any);
        }
      } catch {}
      if (!isLevelTrackingActive()) { res.status(409).json({ error: 'audio level tracking not active yet — try again in a moment' }); return; }
      const speakers = getActiveInputsByAudioLevel([1,2,3,4,5,6,7,8]);
      if (!speakers.length) { res.status(200).json({ ok: false, reason: 'no one is speaking right now' }); return; }
      const target = speakers[0].input;
      if (transition === 'auto') { await atem.changePreviewInput(target, 0); await atem.autoTransition(0); }
      else { await atem.changeProgramInput(target, 0); }
      res.json({ ok: true, speaker: target, level: speakers[0].level });
    } catch (error) { res.status(502).json({ error: String(error) }); }
  });

  // Recording start/stop (no LLM) — body: { on: bool }
  app.post('/state/record', async (req: express.Request, res: express.Response) => {
    try {
      await waitForConnection(5000);
      const atem = getAtem();
      const on = !!req.body?.on;
      if (on) await atem.startRecording(); else await atem.stopRecording();
      res.json({ ok: true, recording: on });
    } catch (error) { res.status(502).json({ error: String(error) }); }
  });

  // Streaming start/stop (no LLM) — body: { on: bool }
  app.post('/state/stream', async (req: express.Request, res: express.Response) => {
    try {
      await waitForConnection(5000);
      const atem = getAtem();
      const on = !!req.body?.on;
      if (on) await atem.startStreaming(); else await atem.stopStreaming();
      res.json({ ok: true, streaming: on });
    } catch (error) { res.status(502).json({ error: String(error) }); }
  });

  // Recording + streaming live status (for the dashboard to poll + PROVE it works)
  app.get('/state/av-status', async (_req: express.Request, res: express.Response) => {
    try {
      await waitForConnection(5000);
      const s = getAtem().state as any;
      res.json({
        recording: {
          state: s?.recording?.status?.state ?? null,
          error: s?.recording?.status?.error ?? null,
          duration: s?.recording?.duration ?? null,
          available: !!s?.recording,
        },
        streaming: {
          state: s?.streaming?.status?.state ?? null,
          error: s?.streaming?.status?.error ?? null,
          duration: s?.streaming?.duration ?? null,
          available: !!s?.streaming,
        },
      });
    } catch (error) { res.status(502).json({ error: String(error) }); }
  });

  // T-bar / manual transition position (no LLM) — body: { position } 0..1
  app.post('/state/transition-position', async (req: express.Request, res: express.Response) => {
    try {
      await waitForConnection(5000);
      const atem = getAtem();
      let pos = Number(req.body?.position);
      if (!Number.isFinite(pos)) { res.status(400).json({ error: 'position (0..1) required' }); return; }
      pos = Math.max(0, Math.min(1, pos));
      await atem.setTransitionPosition(Math.round(pos * 10000), 0);
      res.json({ ok: true, position: pos });
    } catch (error) { res.status(502).json({ error: String(error) }); }
  });

  // Transition style + rate (no LLM) — body: { style: mix|dip|wipe|dve, rate: frames }
  app.post('/state/transition-style', async (req: express.Request, res: express.Response) => {
    try {
      await waitForConnection(5000);
      const atem = getAtem();
      const style = String(req.body?.style || '').toLowerCase();
      const rate = Number(req.body?.rate);
      const styleMap: Record<string, Enums.TransitionStyle> = {
        mix: Enums.TransitionStyle.MIX, dip: Enums.TransitionStyle.DIP,
        wipe: Enums.TransitionStyle.WIPE, dve: Enums.TransitionStyle.DVE,
      };
      if (!(style in styleMap)) { res.status(400).json({ error: 'style must be mix|dip|wipe|dve' }); return; }
      await atem.setTransitionStyle({ nextStyle: styleMap[style] }, 0);
      if (Number.isFinite(rate) && rate > 0) {
        const r = Math.round(rate);
        if (style === 'mix') await atem.setMixTransitionSettings({ rate: r }, 0);
        else if (style === 'dip') await atem.setDipTransitionSettings({ rate: r }, 0);
        else if (style === 'wipe') await atem.setWipeTransitionSettings({ rate: r }, 0);
        else if (style === 'dve') await atem.setDVETransitionSettings({ rate: r }, 0);
      }
      res.json({ ok: true, style, rate: Number.isFinite(rate) ? rate : null });
    } catch (error) { res.status(502).json({ error: String(error) }); }
  });

  // Upstream keyer on-air (no LLM) — body: { keyer: 0, onAir: bool }
  app.post('/state/usk', async (req: express.Request, res: express.Response) => {
    try {
      await waitForConnection(5000);
      const atem = getAtem();
      const keyer = Number(req.body?.keyer ?? 0);
      const onAir = !!req.body?.onAir;
      await atem.setUpstreamKeyerOnAir(onAir, 0, keyer);
      res.json({ ok: true, keyer, onAir });
    } catch (error) { res.status(502).json({ error: String(error) }); }
  });

  // Downstream keyer on-air (no LLM) — body: { keyer: 0, onAir: bool, auto: bool }
  app.post('/state/dsk', async (req: express.Request, res: express.Response) => {
    try {
      await waitForConnection(5000);
      const atem = getAtem();
      const keyer = Number(req.body?.keyer ?? 0);
      if (req.body?.auto) { await atem.autoDownstreamKey(keyer); res.json({ ok: true, keyer, auto: true }); return; }
      const onAir = !!req.body?.onAir;
      await atem.setDownstreamKeyOnAir(onAir, keyer);
      res.json({ ok: true, keyer, onAir });
    } catch (error) { res.status(502).json({ error: String(error) }); }
  });

  // Super Source layouts — reuse the exact PRESETS geometry from the MCP tool,
  // applied directly (no LLM). body: { preset, sources: [..], cut: true }
  app.post('/state/layout', async (req: express.Request, res: express.Response) => {
    try {
      await waitForConnection(5000);
      const atem = getAtem();
      const { preset, sources, cut } = req.body || {};
      const layout = PRESETS[preset];
      if (!layout) {
        res.status(400).json({ error: `unknown preset; available: ${Object.keys(PRESETS).join(', ')}` });
        return;
      }
      // Fire all 4 box updates concurrently (was sequential ~130ms → ~40ms).
      await Promise.all([0, 1, 2, 3].map((i) => {
        const boxProps: Record<string, unknown> = { ...layout.boxes[i] };
        if (Array.isArray(sources) && i < sources.length && layout.boxes[i].enabled) {
          boxProps.source = sources[i];
        }
        return atem.setSuperSourceBoxSettings(boxProps, i, 0);
      }));
      if (cut) await atem.changeProgramInput(6000, 0);
      res.json({ ok: true, preset, cut: !!cut });
    } catch (error) {
      res.status(502).json({ error: String(error) });
    }
  });

  app.post('/mcp', async (req: express.Request, res: express.Response) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      console.error('[AUTH] 401 — no Bearer token');
      res.status(401)
        .header('WWW-Authenticate', `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`)
        .json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: req.body?.id || null });
      return;
    }

    const token = auth.substring(7);

    // Validate JWT token — or a static token shared with trusted local services
    // (prodbots backend), which can't do the interactive OAuth flow
    const staticToken = process.env.MCP_STATIC_TOKEN;
    const validation = (staticToken && token === staticToken)
      ? { valid: true, clientId: 'prodbots-backend', scope: 'mcp:tools' }
      : tokenManager.validateToken(token);
    if (!validation.valid) {
      console.error(`[AUTH] ✗ Invalid token: ${token.substring(0, 8)}...`);
      res.status(401)
        .header('WWW-Authenticate', `Bearer error="invalid_token"`)
        .json({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid or expired token' }, id: req.body?.id || null });
      return;
    }

    // Log audit trail
    const method = req.body?.method || 'unknown';
    const toolName = req.body?.params?.name;
    tokenManager.logRequest(validation.clientId!, method, toolName);

    // Wait for any in-progress ATEM auto-connection to complete before handling requests.
    // This prevents race conditions where tools run before the ATEM state is populated.
    await waitForConnection();

    try {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[ERROR] POST /mcp:', err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });

  app.get('/mcp', (_req: express.Request, res: express.Response) => {
    res.writeHead(405, { Allow: 'POST' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
  });
  app.delete('/mcp', (_req: express.Request, res: express.Response) => {
    res.writeHead(405, { Allow: 'POST' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Not supported.' }, id: null }));
  });

  app.use((req: express.Request, res: express.Response) => {
    console.error(`[404] ${req.method} ${req.path}`);
    res.status(404).json({ error: 'not found' });
  });

  autoConnect();
  const port = parseInt(process.env.PORT || '3000');
  httpServer.listen(port, () => {
    console.error(`[atem-mcp] v1.5.0 | http://localhost:${port}/mcp | OAuth: ${baseUrl} | tools: ${toolMode}`);
  });
}

const transport = process.env.TRANSPORT || 'stdio';
if (transport === 'http') { runHTTP().catch(console.error); } else { runStdio().catch(console.error); }
