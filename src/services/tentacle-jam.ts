// ---------------------------------------------------------------------------
// Tentacle jam — sets every USB-connected Tentacle Sync to the ATEM's timecode
// (or the Mac's time of day, to match an EDL logged from the Mac clock).
//
// The ATEM reports its timecode on request ('TiRq' → 'Time'). We anchor that to
// the Mac's monotonic clock, wait for the next frame boundary, and send the
// timecode of that frame (minus measured USB latency) so the Tentacle starts on
// the same frame. A read-back then measures the residual offset and, if it is
// off by a frame or more, jams once more with the correction applied.
//
// Tentacles run timecode at up to 30 fps; 50p/59.94p switchers are jammed at
// half rate (25 / 29.97), which is the usual convention for camera timecode.
// ---------------------------------------------------------------------------
import { AtemLike, FrameRate, frameRateFromVideoMode, framesToTc, tcToFrames } from './edl-logger.js';
import {
  TentacleDevice, TentacleFrameRate, Timecode, formatRate, formatTc, openTentacles,
} from './tentacle-usb.js';

export interface TentacleRatePlan {
  rate: TentacleFrameRate;
  /** ATEM frames per Tentacle frame (2 for 50p / 59.94p). */
  divisor: 1 | 2;
  /** Timecode base of the Tentacle rate (24, 25, 30). */
  base: number;
}

export function tentacleRateFor(fr: FrameRate, dropFrame: boolean): TentacleRatePlan {
  const divisor = fr.base > 30 ? 2 : 1;
  const base = fr.base / divisor;
  const ntsc = fr.real % 1 !== 0;
  return { rate: { fps: base, ntsc, dropFrame: dropFrame && ntsc && base === 30 }, divisor, base };
}

export interface AtemAnchor {
  /** ATEM timecode in absolute frames (ATEM rate) when it was received. */
  frames: number;
  /** performance.now() at receipt. */
  ms: number;
}

/** Tentacle-rate absolute frames at a given monotonic time. */
export function tentacleFramesAt(anchor: AtemAnchor, ms: number, fr: FrameRate, divisor: number): number {
  return (anchor.frames + ((ms - anchor.ms) / 1000) * fr.real) / divisor;
}

/** Monotonic time at which a Tentacle-rate frame begins. */
export function msForTentacleFrame(anchor: AtemAnchor, frame: number, fr: FrameRate, divisor: number): number {
  return anchor.ms + ((frame * divisor - anchor.frames) / fr.real) * 1000;
}

export function toTimecode(tc: string): Timecode {
  const [hour, minute, second, frame] = tc.split(':').map(Number);
  return { hour, minute, second, frame };
}

/**
 * Pick the frame to jam: the first boundary at least `leadMs` away, so there is
 * time to wait for it. Returns that frame, when to send it (boundary minus the
 * one-way USB latency), and its timecode with `offsetFrames` applied.
 */
export function planJam(anchor: AtemAnchor, nowMs: number, fr: FrameRate, plan: TentacleRatePlan,
  latencyMs: number, offsetFrames: number, leadMs = 20):
  { frame: number; sendAtMs: number; tc: Timecode } {
  let frame = Math.floor(tentacleFramesAt(anchor, nowMs, fr, plan.divisor)) + 1;
  while (msForTentacleFrame(anchor, frame, fr, plan.divisor) - latencyMs - nowMs < leadMs) frame++;
  const sendAtMs = msForTentacleFrame(anchor, frame, fr, plan.divisor) - latencyMs;
  const tc = toTimecode(framesToTc(frame + offsetFrames, plan.base, plan.rate.dropFrame));
  return { frame, sendAtMs, tc };
}

async function waitUntil(ms: number): Promise<void> {
  const coarse = ms - performance.now() - 4;
  if (coarse > 0) await new Promise(r => setTimeout(r, coarse));
  while (performance.now() < ms) { /* spin the last few ms for frame accuracy */ }
}

/**
 * Ask the switcher for its timecode and anchor it to performance.now().
 *
 * The switcher answers on its own frame clock, and a reply can arrive several frames
 * after the time it reports (seen on a Constellation 4K: 0–5 frames, varying per reply).
 * A late reply always reads behind, never ahead, so we ask several times and anchor on
 * the reply that reads furthest ahead of the Mac clock: the least delayed one.
 */
export async function readAtemTime(atem: AtemLike, timeoutMs = 1500, samples = 12):
  Promise<{ anchor: AtemAnchor; fr: FrameRate; dropFrame: boolean }> {
  const fr = frameRateFromVideoMode(atem.state?.settings?.videoMode);
  let dropFrame = fr.real % 1 !== 0 && (fr.base === 30 || fr.base === 60);
  const replies: { t: any; ms: number }[] = [];
  let requestError: unknown = null;
  const onTime = (t: any) => { replies.push({ t, ms: performance.now() }); };
  atem.on('updatedTime', onTime);
  try {
    const start = performance.now();
    for (let i = 0; i < samples && performance.now() - start < timeoutMs; i++) {
      atem.requestTime().catch(err => { requestError ??= err; });
      await new Promise(r => setTimeout(r, 40));
    }
    while (replies.length < samples && performance.now() - start < timeoutMs) await new Promise(r => setTimeout(r, 10));
  } finally {
    atem.off('updatedTime', onTime);
  }
  if (!replies.length) {
    throw requestError instanceof Error ? requestError
      : new Error('The switcher did not report its timecode (needs ATEM firmware 8.0 or later).');
  }
  const last = replies[replies.length - 1].t;
  if (typeof last.dropFrame === 'boolean') dropFrame = last.dropFrame;
  const day = tcToFrames(24, 0, 0, 0, fr.base, dropFrame);
  const first = replies[0];
  let best: AtemAnchor | null = null, bestLead = -Infinity;
  for (const { t, ms } of replies) {
    let frames = tcToFrames(t.hour, t.minute, t.second, t.frame, fr.base, dropFrame);
    const firstFrames = tcToFrames(first.t.hour, first.t.minute, first.t.second, first.t.frame, fr.base, dropFrame);
    if (frames - firstFrames < -day / 2) frames += day; // crossed midnight during the burst
    const lead = frames - (ms / 1000) * fr.real;
    if (lead > bestLead) { bestLead = lead; best = { frames, ms }; }
  }
  return { anchor: best!, fr, dropFrame };
}

/**
 * Mac time of day as timecode, counted exactly as the EDL logger's "clock" source
 * does, so Tentacles jammed this way match an EDL logged with tc_source "clock".
 */
export function readClockTime(atem: AtemLike | null):
  { anchor: AtemAnchor; fr: FrameRate; dropFrame: boolean } {
  const fr = frameRateFromVideoMode(atem?.state?.settings?.videoMode);
  const dropFrame = fr.real % 1 !== 0 && (fr.base === 30 || fr.base === 60);
  const d = new Date();
  const ms = performance.now();
  const secs = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
  return { anchor: { frames: secs * fr.real, ms }, fr, dropFrame };
}

export type JamSource = 'atem' | 'clock';

export async function readSourceTime(atem: AtemLike | null, source: JamSource) {
  if (source === 'clock') return readClockTime(atem);
  if (!atem) throw new Error('Not connected to the switcher.');
  return readAtemTime(atem);
}

export interface JamOptions {
  /** Timecode to jam: the switcher's (default) or the Mac's time of day. */
  source?: JamSource;
  /** Also set each Tentacle's frame rate to match the switcher (default true). */
  setFrameRate?: boolean;
  /** Frames added to the jammed timecode, to compensate a known device offset. */
  offsetFrames?: number;
  /** Read back and re-jam once if the device is a frame or more off (default true). */
  autoCorrect?: boolean;
}

export interface DeviceReport {
  device: string;
  frameRate: string;
  jammedTo?: string;
  /** Device TC minus ATEM TC, in Tentacle frames, measured after the jam. */
  offsetFrames?: number;
  timecode?: string;
  error?: string;
}

/** Device timecode minus ATEM timecode in Tentacle frames, median of a few read-backs. */
async function measureOffset(t: TentacleDevice, anchor: AtemAnchor, fr: FrameRate,
  plan: TentacleRatePlan): Promise<{ offset: number; tc: string }> {
  const df = plan.rate.dropFrame;
  const day = tcToFrames(24, 0, 0, 0, plan.base, df);
  const deltas: number[] = [];
  let tc = '';
  for (let i = 0; i < 3; i++) {
    const sent = performance.now();
    const got = await t.getTimecode();
    const mid = (sent + performance.now()) / 2;
    tc = formatTc(got);
    const dev = tcToFrames(got.hour, got.minute, got.second, got.frame, plan.base, df);
    let d = dev - tentacleFramesAt(anchor, mid, fr, plan.divisor);
    d = ((d % day) + day + day / 2) % day - day / 2; // wrap across midnight
    deltas.push(d);
  }
  deltas.sort((a, b) => a - b);
  // The device reports whole frames, so an exactly synced Tentacle reads 0 to 1 frame behind
  // the continuous switcher estimate; centre that window on zero before rounding.
  return { offset: Math.round(deltas[1] + 0.5), tc };
}

async function jamOnce(devices: TentacleDevice[], atem: AtemLike | null, source: JamSource, offsetFrames: number) {
  const { anchor, fr, dropFrame } = await readSourceTime(atem, source);
  const plan = tentacleRateFor(fr, dropFrame);
  // One-way USB latency ≈ half a round trip, measured on the first device.
  const t0 = performance.now();
  await devices[0].getTimecode();
  const latencyMs = (performance.now() - t0) / 2;
  const target = planJam(anchor, performance.now(), fr, plan, latencyMs, offsetFrames);
  await waitUntil(target.sendAtMs);
  const results = await Promise.allSettled(devices.map(d => d.setTimecode(target.tc)));
  return { anchor, fr, plan, target, results };
}

export async function jamTentacles(atem: AtemLike | null, opts: JamOptions = {}): Promise<{
  source: JamSource; sourceTimecode: string; sourceRate: string; tentacleRate: string; reports: DeviceReport[];
}> {
  const source = opts.source ?? 'atem';
  const devices = await openTentacles();
  if (!devices.length) throw new Error('No Tentacle Sync found on USB. Connect it with a USB cable and switch it on.');
  try {
    const first = await readSourceTime(atem, source);
    const plan = tentacleRateFor(first.fr, first.dropFrame);
    const reports: DeviceReport[] = devices.map(d => ({ device: d.id, frameRate: '' }));

    for (const [i, d] of devices.entries()) {
      try {
        if (opts.setFrameRate !== false) await d.setFramerate(plan.rate);
        reports[i].frameRate = formatRate(await d.getFramerate());
      } catch (err) {
        reports[i].error = (err as Error).message;
      }
    }

    const live = devices.filter((_, i) => !reports[i].error);
    if (!live.length) throw new Error(reports.map(r => `${r.device}: ${r.error}`).join('; '));

    let offset = opts.offsetFrames ?? 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const jam = await jamOnce(live, atem, source, offset);
      let worst = 0;
      for (const [j, d] of live.entries()) {
        const r = reports[devices.indexOf(d)];
        const res = jam.results[j];
        if (res.status === 'rejected') { r.error = (res.reason as Error).message; continue; }
        r.jammedTo = formatTc(jam.target.tc);
        const m = await measureOffset(d, jam.anchor, jam.fr, jam.plan);
        r.offsetFrames = m.offset;
        r.timecode = m.tc;
        if (Math.abs(m.offset) > Math.abs(worst)) worst = m.offset;
      }
      if (opts.autoCorrect === false || worst === 0) break;
      offset -= worst;
    }

    const now = performance.now();
    const atemFrames = first.anchor.frames + ((now - first.anchor.ms) / 1000) * first.fr.real;
    return {
      source,
      sourceTimecode: framesToTc(atemFrames, first.fr.base, first.dropFrame),
      sourceRate: `${first.fr.label}${first.dropFrame ? ' DF' : ''}`,
      tentacleRate: formatRate(plan.rate),
      reports,
    };
  } finally {
    await Promise.all(devices.map(d => d.close()));
  }
}

/** Read each Tentacle's timecode and compare it with the source's (no changes made). */
export async function checkTentacles(atem: AtemLike | null, source: JamSource = 'atem'): Promise<{
  sourceTimecode?: string; reports: DeviceReport[];
}> {
  const devices = await openTentacles();
  try {
    const atemTime = await readSourceTime(atem, source).catch(() => null);
    const reports: DeviceReport[] = [];
    for (const d of devices) {
      try {
        const rate = await d.getFramerate();
        const r: DeviceReport = { device: d.id, frameRate: formatRate(rate) };
        if (atemTime) {
          const plan = tentacleRateFor(atemTime.fr, atemTime.dropFrame);
          const m = await measureOffset(d, atemTime.anchor, atemTime.fr, plan);
          r.timecode = m.tc;
          r.offsetFrames = m.offset;
        } else {
          r.timecode = formatTc(await d.getTimecode());
        }
        reports.push(r);
      } catch (err) {
        reports.push({ device: d.id, frameRate: '', error: (err as Error).message });
      }
    }
    const sourceTimecode = atemTime
      ? framesToTc(atemTime.anchor.frames + ((performance.now() - atemTime.anchor.ms) / 1000) * atemTime.fr.real,
        atemTime.fr.base, atemTime.dropFrame)
      : undefined;
    return { sourceTimecode, reports };
  } finally {
    await Promise.all(devices.map(d => d.close()));
  }
}
