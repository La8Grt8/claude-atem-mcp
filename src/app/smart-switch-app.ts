#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Smart Switch — standalone app. Runs the bleed-aware switching engine on its
// own, without Claude or MCP: connects straight to the ATEM, reads the mics,
// and serves a control panel in the browser.
//
//   npm run smart-switch                       # http://localhost:3020
//   npm run smart-switch -- --atem 192.168.1.240 --port 3020
//   npm run smart-switch -- --lan              # reachable from other devices (no login!)
//
// Settings, profiles and calibration live in the same file the MCP tools use,
// so a show set up in one is ready in the other. Don't run the smart switch in
// both at once — they would both try to cut.
// ---------------------------------------------------------------------------

import express from 'express';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import * as path from 'path';
import { Enums } from 'atem-connection';
import { connectAtem, disconnectAtem, getAtem, isAtemConnected } from '../services/atem-connection.js';
import { smartSwitch } from '../smart/controller.js';
import { listAudioDevices } from '../smart/audio-device.js';
import {
  calibrate, calibrateSchema, calibrationSummary, describeProfile, profileAction, profileSchema,
  setup, setupSchema, startMeters, switchOff, switchOn,
} from '../smart/actions.js';

// ------------------------------- arguments ----------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const PORT = Number(arg('port') ?? process.env.SMART_SWITCH_PORT ?? 3020);
const LAN = process.argv.includes('--lan');
const OPEN = !process.argv.includes('--no-open');
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'public');

const cliHost = arg('atem') ?? process.env.ATEM_HOST;
if (cliHost) smartSwitch.config.atemHost = cliHost;

// ------------------------------- ATEM link ----------------------------------

let connecting = false;
let lastError: string | null = null;
let downSince: number | null = null;

async function connect(host: string): Promise<void> {
  connecting = true;
  try {
    await disconnectAtem().catch(() => undefined);
    console.error(`[app] connecting to ATEM at ${host}…`);
    console.error(`[app] ${await connectAtem(host)}`);
    lastError = null;
    downSince = null;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    console.error(`[app] ${lastError}`);
  } finally {
    connecting = false;
  }
}

/** Keep the ATEM connected: retry every 5 s, and rebuild the link if the library's own reconnect hasn't worked in 15 s. */
setInterval(() => {
  const host = smartSwitch.config.atemHost;
  if (!host || connecting) return;
  if (isAtemConnected()) { downSince = null; return; }
  downSince ??= Date.now();
  if (lastError !== null || Date.now() - downSince > 15000) void connect(host);
}, 5000);

function atemInfo() {
  if (!isAtemConnected()) {
    return { connected: false, connecting, host: smartSwitch.config.atemHost, error: lastError };
  }
  const atem = getAtem();
  const me = smartSwitch.profile().rules.me;
  const inputs = Object.values(atem.state?.inputs ?? {})
    .filter((i): i is NonNullable<typeof i> => !!i)
    .map(i => ({
      input: i.inputId, short: i.shortName, long: i.longName,
      external: i.internalPortType === Enums.InternalPortType.External,
    }))
    .sort((a, b) => a.input - b.input);
  return {
    connected: true, connecting: false, host: smartSwitch.config.atemHost, error: null,
    model: atem.state?.info?.productIdentifier ?? 'ATEM',
    program: atem.state?.video?.mixEffects?.[me]?.programInput ?? null,
    preview: atem.state?.video?.mixEffects?.[me]?.previewInput ?? null,
    inputs,
  };
}

function state() {
  return {
    atem: atemInfo(),
    smart: smartSwitch.status(),
    profile: describeProfile(),
    profiles: smartSwitch.config.profiles.map(p => p.name),
    calibration: calibrationSummary(),
    configPath: smartSwitch.configPath(),
  };
}

// ------------------------------- HTTP ---------------------------------------

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

type Handler = (req: express.Request) => Promise<unknown> | unknown;
const route = (fn: Handler) => async (req: express.Request, res: express.Response) => {
  try {
    res.json({ ok: true, result: await fn(req) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};

app.get('/api/state', route(() => state()));

/** Server-sent events: full state 10× a second while the panel is open. */
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = () => res.write(`data: ${JSON.stringify(state())}\n\n`);
  send();
  const t = setInterval(send, 100);
  req.on('close', () => clearInterval(t));
});

app.get('/api/devices', route(async () => ({ devices: await listAudioDevices(), current: smartSwitch.deviceStatus() })));

app.post('/api/connect', route(async (req) => {
  const host = String(req.body?.host ?? '').trim();
  if (!/^[\w.:-]+$/.test(host)) throw new Error('Enter the ATEM\'s IP address or host name.');
  smartSwitch.config.atemHost = host;
  await smartSwitch.save();
  await connect(host);
  if (!isAtemConnected()) throw new Error(lastError ?? 'Could not connect.');
  return atemInfo();
}));

app.post('/api/meters', route(async () => { await startMeters(); return smartSwitch.status().meters; }));
app.post('/api/switch', route(async (req) => (req.body?.on ? switchOn(!!req.body?.simulate) : switchOff())));
app.post('/api/resume', route(() => { smartSwitch.releaseHold(); return 'resumed'; }));
app.post('/api/cut', route(async (req) => {
  const input = Number(req.body?.input);
  if (!Number.isInteger(input) || input < 1) throw new Error('input must be an ATEM input number.');
  await smartSwitch.manualCut(input);
  return input;
}));
app.post('/api/setup', route((req) => setup(setupSchema.parse(req.body ?? {}))));
app.post('/api/profile', route((req) => profileAction(profileSchema.parse(req.body ?? {}))));
app.post('/api/calibrate', route((req) => calibrate(calibrateSchema.parse(req.body ?? {}))));
app.get('/api/cuts.csv', (_req, res) => {
  const rows = [['time', 'input', 'name', 'source', 'reason'], ...smartSwitch.cuts().map(c => [c.at, String(c.input), c.name, c.source, c.reason])];
  res.type('text/csv').attachment('smart-switch-cuts.csv')
    .send(rows.map(r => r.map(v => `"${v.replace(/"/g, '""')}"`).join(',')).join('\n'));
});

const bind = LAN ? '0.0.0.0' : '127.0.0.1';
const server = app.listen(PORT, bind, () => {
  const url = `http://localhost:${PORT}`;
  console.error(`[app] Smart Switch control panel: ${url}${LAN ? `  (also on this Mac's LAN address, port ${PORT} — no login, trusted networks only)` : ''}`);
  console.error(`[app] settings: ${smartSwitch.configPath()}`);
  if (OPEN && process.platform === 'darwin') exec(`open ${url}`);
  startMeters().catch(e => console.error(`[app] meters: ${e instanceof Error ? e.message : e}`));
  if (smartSwitch.config.atemHost) void connect(smartSwitch.config.atemHost);
  else console.error('[app] No ATEM address yet: enter it in the control panel, or start with --atem <ip>.');
});
server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(e.code === 'EADDRINUSE'
    ? `[app] Port ${PORT} is busy: Smart Switch is probably already running (or pass --port).`
    : `[app] ${e.message}`);
  process.exit(1);
});

async function shutdown() {
  console.error('[app] shutting down…');
  if (smartSwitch.isSwitching()) switchOff();
  smartSwitch.stopMeters();
  await smartSwitch.save().catch(() => undefined);
  await disconnectAtem().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
