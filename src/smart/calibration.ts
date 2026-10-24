// ---------------------------------------------------------------------------
// Calibration — turns short recordings of per-mic levels into learned values.
// All functions are pure: the controller records frames (one Record<micId, dB>
// per tick) for a few seconds and hands them over.
//
//   1. noise:    nobody talks → each mic's noise floor
//   2. speaker:  one person talks alone → their speech level and how much of
//                their voice reaches every other mic (the bleed row)
//   3. together: several people talk at once → replay through the engine and
//                check nobody gets hidden; loosen the bleed filter if they do
// ---------------------------------------------------------------------------

import { SwitchEngine, ENGINE_CONSTANTS } from './engine.js';
import { Profile, SILENCE_DB, median } from './types.js';

export type Frame = Record<string, number>;
export interface TimedFrame { t: number; levels: Frame; }

/** dB a mic must clear its floor by for a frame to count as the speaker's voice. */
const VOICED_OVER_FLOOR_DB = 15;
/** Fewer voiced ticks than this and we say we didn't hear them. */
const MIN_VOICED_FRAMES = 15;
/** Pairs whose bleed is above this pick up almost the same thing. */
const CLOSE_PAIR_DB = -6;
/** Share of the "together" test a person must be detected for. */
const OK_SHARE = 0.4;
/** How much a failed "together" test loosens the bleed into a hidden mic. */
const RELAX_DB = 6;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return SILENCE_DB;
  const a = [...values].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
}

export interface NoiseResult {
  /** Floors for mics that had a signal; mics with none are left out so nothing bogus gets saved. */
  floors: Record<string, number>;
  silent: string[];
  warnings: string[];
}

export function measureNoise(frames: Frame[], micIds: string[], names: Record<string, string>): NoiseResult {
  const floors: Record<string, number> = {};
  const silent: string[] = [];
  const warnings: string[] = [];
  for (const id of micIds) {
    const vals = frames.map(f => f[id] ?? SILENCE_DB);
    const floor = Math.min(ENGINE_CONSTANTS.NOISE_MAX_DB, percentile(vals, 0.2));
    if (floor <= SILENCE_DB + 1) {
      silent.push(id);
      warnings.push(`${names[id]}: no signal at all — check the channel/input mapping.`);
      continue;
    }
    floors[id] = floor;
    const spread = percentile(vals, 0.95) - floor;
    if (spread > 15) warnings.push(`${names[id]}: level jumped ${spread.toFixed(0)} dB during the quiet test — was someone talking or moving?`);
  }
  return { floors, silent, warnings };
}

export interface SpeakerResult {
  ok: boolean;
  speechDb: number | null;
  bleedRow: Record<string, number>;
  voicedFrames: number;
  /** When we heard nothing on the expected mic but another one sounded. */
  suggestedMic: string | null;
  warnings: string[];
}

export function measureSpeaker(
  frames: Frame[], src: string, micIds: string[], floors: Record<string, number>, names: Record<string, string>,
): SpeakerResult {
  const floorOf = (id: string) => floors[id] ?? percentile(frames.map(f => f[id] ?? SILENCE_DB), 0.2);
  const others = micIds.filter(id => id !== src);
  const voiced = frames.filter(f => {
    const s = f[src] ?? SILENCE_DB;
    return s > floorOf(src) + VOICED_OVER_FLOOR_DB && others.every(o => (f[o] ?? SILENCE_DB) < s);
  });

  if (voiced.length < MIN_VOICED_FRAMES) {
    // did another mic carry voice instead?
    let best: string | null = null;
    let bestOver = VOICED_OVER_FLOOR_DB;
    for (const o of others) {
      const over = percentile(frames.map(f => f[o] ?? SILENCE_DB), 0.8) - floorOf(o);
      if (over > bestOver) { bestOver = over; best = o; }
    }
    return {
      ok: false, speechDb: null, bleedRow: {}, voicedFrames: voiced.length, suggestedMic: best,
      warnings: [`Didn't hear ${names[src]}'s voice on their mic.` + (best ? ` But ${names[best]}'s mic did sound — is that their mic?` : '')],
    };
  }

  const speechDb = median(voiced.map(f => f[src]));
  const bleedRow: Record<string, number> = {};
  const warnings: string[] = [];
  for (const d of others) {
    const measurable = voiced.filter(f => (f[d] ?? SILENCE_DB) > floorOf(d) + ENGINE_CONSTANTS.BLEED_MEASURABLE_DB);
    // Mostly below the floor → the true bleed is at most "floor − speech"; that bound is safe to use.
    const db = measurable.length >= voiced.length * 0.3
      ? median(measurable.map(f => f[d] - f[src]))
      : floorOf(d) - speechDb;
    bleedRow[d] = Math.min(ENGINE_CONSTANTS.BLEED_CAP_DB, db);
    if (bleedRow[d] > CLOSE_PAIR_DB) {
      warnings.push(`${names[d]}'s mic picks up almost the same as ${names[src]}'s (${bleedRow[d].toFixed(1)} dB): move each mic closer to its person or further apart, or they may be confused when talking at once.`);
    }
  }
  return { ok: true, speechDb, bleedRow, voicedFrames: voiced.length, suggestedMic: null, warnings };
}

export interface TogetherResult {
  /** Share of the test each expected person was detected talking (0–1). */
  detectedShare: Record<string, number>;
  /** Share of the test the engine's target camera showed every expected person. */
  correctShotShare: number;
  relaxed: string[];
  hidden: string[];
  warnings: string[];
}

/** Replay recorded frames through a fresh engine (simulation only — no cuts sent). */
export function replay(profile: Profile, frames: TimedFrame[]): { talking: Record<string, number>; targets: (number | null)[] } {
  const sim: Profile = JSON.parse(JSON.stringify(profile));
  sim.rules.adaptive = false;
  const eng = new SwitchEngine(sim);
  const talking: Record<string, number> = {};
  const targets: (number | null)[] = [];
  for (const f of frames) {
    const d = eng.update(f.levels, f.t);
    targets.push(d.target);
    for (const s of eng.status()) if (s.ownVoice) talking[s.id] = (talking[s.id] ?? 0) + 1;
  }
  return { talking, targets };
}

/**
 * Check that everyone in `expected` is detected while they talk at once. Any
 * person detected less than OK_SHARE of the time gets the bleed into their mic
 * loosened by RELAX_DB (mutating `profile.learned`) and the replay is re-run once.
 */
export function checkTogether(profile: Profile, frames: TimedFrame[], expected: string[]): TogetherResult {
  const names = Object.fromEntries(profile.mics.map(m => [m.id, m.name]));
  const voicedTicks = (talking: Record<string, number>) => {
    const share: Record<string, number> = {};
    for (const id of expected) share[id] = frames.length ? (talking[id] ?? 0) / frames.length : 0;
    return share;
  };

  let { talking, targets } = replay(profile, frames);
  let share = voicedTicks(talking);
  const relaxed: string[] = [];
  for (const id of expected) {
    if (share[id] >= OK_SHARE) continue;
    for (const src of Object.keys(profile.learned.bleedDb)) {
      const row = profile.learned.bleedDb[src];
      if (src !== id && row[id] !== undefined) row[id] -= RELAX_DB;
    }
    relaxed.push(id);
  }
  if (relaxed.length) ({ talking, targets } = replay(profile, frames), share = voicedTicks(talking));

  const showsAll = (input: number | null) => {
    const cam = profile.cameras.find(c => c.input === input);
    return !!cam && expected.every(id => cam.mics.includes(id));
  };
  const correctShotShare = targets.length ? targets.filter(showsAll).length / targets.length : 0;
  const hidden = expected.filter(id => share[id] < OK_SHARE);
  const warnings: string[] = [];
  const quiet = frames.length === 0 || expected.every(id => share[id] < 0.05);
  if (quiet) warnings.push('Barely heard any voice: did everyone talk the whole time? Redo the test.');
  else if (hidden.length) {
    warnings.push(`${hidden.map(id => names[id]).join(', ')} still gets hidden when people talk at once: their mic picks up almost the same as the others'. Move each mic closer to its person or separate them.`);
  }
  if (relaxed.length) warnings.push(`Loosened the bleed filter for ${relaxed.map(id => names[id]).join(', ')} so they don't get hidden.`);
  return { detectedShare: share, correctShotShare, relaxed: relaxed.map(id => names[id]), hidden: hidden.map(id => names[id]), warnings };
}
