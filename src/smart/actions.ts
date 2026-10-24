// ---------------------------------------------------------------------------
// Smart switch actions — the operations shared by the MCP tools and the
// standalone app's HTTP API: setup, profiles, calibration, start/stop. Inputs
// are validated with the zod shapes exported here; errors are thrown.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import { smartSwitch } from './controller.js';
import { checkTogether, measureNoise, measureSpeaker } from './calibration.js';
import { Mic, Profile, Rules, SpeedKey, applySpeed, profileProblems } from './types.js';
import { getAtem, isAtemConnected } from '../services/atem-connection.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const r1 = (x: number) => Math.round(x * 10) / 10;

export const SPEEDS = ['very_fast', 'fast', 'normal', 'calm', 'custom'] as const;

/** Resolve a person/mic by name (case-insensitive) or id. */
export function micByName(p: Profile, name: string): Mic {
  const n = name.trim().toLowerCase();
  const m = p.mics.find(x => x.name.toLowerCase() === n || x.id === name);
  if (!m) throw new Error(`No mic named "${name}". Mics: ${p.mics.map(x => x.name).join(', ') || '(none)'}`);
  return m;
}

function names(p: Profile): Record<string, string> {
  return Object.fromEntries(p.mics.map(m => [m.id, m.name]));
}

export async function startMeters(): Promise<void> {
  const wasRunning = smartSwitch.metersRunning();
  await smartSwitch.ensureMeters();
  if (!wasRunning) await sleep(600);   // let the floors and envelopes settle
}

// ------------------------------- setup --------------------------------------

export const setupShape = {
  audio_device: z.string().nullable().optional().describe('USB mixer device index or name (null to clear)'),
  mics: z.array(z.object({
    name: z.string().min(1),
    atem_input: z.number().int().min(1).optional(),
    channel: z.number().int().min(1).max(64).optional(),
    enabled: z.boolean().optional(),
    threshold_db: z.number().min(-100).max(0).nullable().optional(),
  })).optional().describe('All mics (replaces the list)'),
  cameras: z.array(z.object({
    input: z.number().int().min(1),
    name: z.string().optional(),
    people: z.array(z.string()),
  })).optional().describe('All camera inputs (replaces the list)'),
  speed: z.enum(SPEEDS).optional(),
  rules: z.object({
    min_shot_ms: z.number().int().min(0).max(60000),
    switch_delay_ms: z.number().int().min(0).max(10000),
    attack_ms: z.number().int().min(0).max(5000),
    release_ms: z.number().int().min(0).max(10000),
    group_count: z.number().int().min(2).max(16),
    group_confirm_ms: z.number().int().min(0).max(30000),
    group_shot: z.enum(['wide', 'tightest']),
    silence_action: z.enum(['stay', 'wide', 'camera']),
    silence_camera: z.number().int().min(1).nullable(),
    silence_ms: z.number().int().min(0).max(120000),
    variety_ms: z.number().int().min(0).max(600000),
    variety_hold_ms: z.number().int().min(0).max(30000),
    manual_hold_ms: z.number().int().min(0).max(120000),
    respect_other_sources: z.boolean(),
    transition: z.enum(['cut', 'auto']),
    me: z.number().int().min(0).max(3),
    auto_margin_db: z.number().min(0).max(40),
    bleed_margin_db: z.number().min(0).max(30),
    weak_mic_reject_db: z.number().min(0).max(60).nullable(),
    adaptive: z.boolean(),
  }).partial().optional(),
};
export const setupSchema = z.object(setupShape);
export type SetupInput = z.infer<typeof setupSchema>;

const RULE_KEYS: Record<string, keyof Rules> = {
  min_shot_ms: 'minShotMs', switch_delay_ms: 'switchDelayMs', attack_ms: 'attackMs', release_ms: 'releaseMs',
  group_count: 'groupCount', group_confirm_ms: 'groupConfirmMs', group_shot: 'groupShot', silence_action: 'silenceAction',
  silence_camera: 'silenceCamera', silence_ms: 'silenceMs', variety_ms: 'varietyMs', variety_hold_ms: 'varietyHoldMs',
  manual_hold_ms: 'manualHoldMs', respect_other_sources: 'respectOtherSources', transition: 'transition', me: 'me',
  auto_margin_db: 'autoMarginDb', bleed_margin_db: 'bleedMarginDb', weak_mic_reject_db: 'weakMicRejectDb', adaptive: 'adaptive',
};
const TIMING_KEYS = ['min_shot_ms', 'switch_delay_ms', 'attack_ms', 'release_ms'];

export function describeProfile(p: Profile = smartSwitch.profile()) {
  return {
    profile: p.name,
    audioDevice: smartSwitch.config.audioDevice,
    mics: p.mics.map(m => ({ name: m.name, source: m.source, enabled: m.enabled, thresholdDb: m.manualThresholdDb })),
    cameras: p.cameras.map(c => ({ input: c.input, name: c.name, people: c.mics.map(id => names(p)[id]) })),
    speed: p.speed,
    rules: p.rules,
    problems: profileProblems(p),
  };
}

export async function setup(input: SetupInput) {
  const { audio_device, mics, cameras, speed, rules } = input;
  const p = smartSwitch.profile();
  if (audio_device !== undefined) smartSwitch.config.audioDevice = audio_device;

  if (mics) {
    const next: Mic[] = [];
    let n = 1;
    const usedIds = new Set<string>();
    for (const m of mics) {
      if ((m.atem_input === undefined) === (m.channel === undefined)) {
        throw new Error(`Mic "${m.name}": give exactly one of atem_input or channel.`);
      }
      const old = p.mics.find(x => x.name.toLowerCase() === m.name.toLowerCase());
      let id = old?.id;
      if (!id || usedIds.has(id)) { while (p.mics.some(x => x.id === `m${n}`) || usedIds.has(`m${n}`)) n++; id = `m${n}`; }
      usedIds.add(id);
      next.push({
        id, name: m.name,
        source: m.atem_input !== undefined ? { kind: 'atem', input: m.atem_input } : { kind: 'device', channel: m.channel! },
        enabled: m.enabled ?? old?.enabled ?? true,
        manualThresholdDb: m.threshold_db !== undefined ? m.threshold_db : (old?.manualThresholdDb ?? null),
      });
    }
    // forget learned values of mics that are gone or moved to another channel
    const keep = new Set(next.filter(m => {
      const old = p.mics.find(x => x.id === m.id);
      return old && JSON.stringify(old.source) === JSON.stringify(m.source);
    }).map(m => m.id));
    for (const id of Object.keys(p.learned.noiseFloorDb)) if (!keep.has(id)) delete p.learned.noiseFloorDb[id];
    for (const id of Object.keys(p.learned.speechDb)) if (!keep.has(id)) delete p.learned.speechDb[id];
    for (const src of Object.keys(p.learned.bleedDb)) {
      if (!keep.has(src)) { delete p.learned.bleedDb[src]; continue; }
      for (const dst of Object.keys(p.learned.bleedDb[src])) if (!keep.has(dst)) delete p.learned.bleedDb[src][dst];
    }
    p.mics = next;
    // drop people that no longer exist from camera shots
    for (const c of p.cameras) c.mics = c.mics.filter(id => next.some(m => m.id === id));
  }

  if (cameras) {
    p.cameras = cameras.map(c => ({
      input: c.input,
      name: c.name || (isAtemConnected() ? (getAtem().state?.inputs?.[c.input]?.shortName ?? `Cam ${c.input}`) : `Cam ${c.input}`),
      mics: c.people.map(n => micByName(p, n).id),
    }));
  }

  if (speed) applySpeed(p, speed as SpeedKey);
  if (rules) {
    for (const [k, v] of Object.entries(rules)) {
      if (v === undefined) continue;
      (p.rules as unknown as Record<string, unknown>)[RULE_KEYS[k]] = v;
      if (TIMING_KEYS.includes(k) && !speed) p.speed = 'custom';
    }
  }

  smartSwitch.profileChanged();
  await smartSwitch.save();
  const d = describeProfile(p);
  return {
    saved: smartSwitch.configPath(),
    ...d,
    next: d.problems.length ? 'Fix the problems above.' : 'Calibrate (noise → each speaker → together), or start in simulation to watch its decisions.',
  };
}

// ------------------------------- profiles -----------------------------------

export const profileShape = {
  action: z.enum(['list', 'get', 'use', 'create', 'delete']),
  name: z.string().optional().describe('Profile name (use/create/delete)'),
  copy_from: z.string().optional().describe('Create as a copy of this profile'),
};
export const profileSchema = z.object(profileShape);

export async function profileAction({ action, name, copy_from }: z.infer<typeof profileSchema>) {
  const cfg = smartSwitch.config;
  const list = () => ({ active: cfg.activeProfile, profiles: cfg.profiles.map(p => ({ name: p.name, mics: p.mics.length, cameras: p.cameras.length, speed: p.speed })) });
  if (action === 'list') return list();
  if (action === 'get') return smartSwitch.profile();
  if (!name) throw new Error('name is required for this action.');
  if (action === 'use') {
    if (smartSwitch.isSwitching()) throw new Error('Stop the smart switch before changing profile.');
    smartSwitch.useProfile(name);
  } else if (action === 'create') {
    smartSwitch.createProfile(name, copy_from);
  } else {
    smartSwitch.deleteProfile(name);
  }
  await smartSwitch.save();
  return list();
}

// ------------------------------- calibration --------------------------------

export const calibrateShape = {
  step: z.enum(['noise', 'speaker', 'together', 'summary']),
  mic: z.string().optional().describe('Person/mic name for the speaker step'),
  people: z.array(z.string()).optional().describe('Who talks at once in the together step (default everyone)'),
  seconds: z.number().min(3).max(60).optional(),
  put_on_air: z.boolean().default(false).describe('Speaker step: cut to their camera while learning'),
};
export const calibrateSchema = z.object(calibrateShape);

export function calibrationSummary(p: Profile = smartSwitch.profile()) {
  const enabled = p.mics.filter(m => m.enabled);
  const matrix: Record<string, Record<string, number | null>> = {};
  for (const s of enabled) {
    matrix[s.name] = {};
    for (const d of enabled) if (d.id !== s.id) {
      const v = p.learned.bleedDb[s.id]?.[d.id];
      matrix[s.name][d.name] = v === undefined ? null : r1(v);
    }
  }
  const missingNoise = enabled.filter(m => p.learned.noiseFloorDb[m.id] === undefined).map(m => m.name);
  const missingSpeaker = enabled.filter(m => !p.learned.bleedDb[m.id] || Object.keys(p.learned.bleedDb[m.id]).length < enabled.length - 1).map(m => m.name);
  return {
    step: 'summary',
    profile: p.name,
    noiseFloorDb: Object.fromEntries(enabled.map(m => [m.name, p.learned.noiseFloorDb[m.id] === undefined ? null : r1(p.learned.noiseFloorDb[m.id])])),
    speechDb: Object.fromEntries(enabled.map(m => [m.name, p.learned.speechDb[m.id] === undefined ? null : r1(p.learned.speechDb[m.id])])),
    bleedDb: matrix,
    note: 'bleedDb[A][B] = how loud A sounds in B\'s mic relative to A\'s own mic. More negative = better separated; above −6 dB means the two mics hear almost the same.',
    missing: { noise: missingNoise, speaker: missingSpeaker },
    problems: profileProblems(p),
  };
}

export async function calibrate(input: z.infer<typeof calibrateSchema>) {
  const { step, mic, people, seconds, put_on_air } = input;
  const p = smartSwitch.profile();
  const enabled = p.mics.filter(m => m.enabled);
  const ids = enabled.map(m => m.id);
  const nm = names(p);
  if (step === 'summary') return calibrationSummary(p);
  if (enabled.length === 0) throw new Error('No mics are enabled. Set them up first.');

  await startMeters();

  if (step === 'noise') {
    const frames = await smartSwitch.record((seconds ?? 8) * 1000);
    const r = measureNoise(frames.map(f => f.levels), ids, nm);
    Object.assign(p.learned.noiseFloorDb, r.floors);
    smartSwitch.profileChanged();
    await smartSwitch.save();
    return {
      step: 'noise', ok: r.silent.length === 0, frames: frames.length,
      noiseFloorDb: Object.fromEntries(Object.entries(r.floors).map(([id, v]) => [nm[id], r1(v)])),
      warnings: r.warnings,
      next: `Now only ${enabled[0].name} talks: speaker step for "${enabled[0].name}".`,
      nextMic: enabled[0].name,
    };
  }

  if (step === 'speaker') {
    if (!mic) throw new Error('mic is required for the speaker step.');
    const m = micByName(p, mic);
    if (put_on_air && !smartSwitch.isSwitching() && isAtemConnected()) {
      const cam = p.cameras.filter(c => c.mics.includes(m.id)).sort((a, b) => a.mics.length - b.mics.length)[0];
      if (cam) await getAtem().changeProgramInput(cam.input, p.rules.me);
    }
    const frames = await smartSwitch.record((seconds ?? 10) * 1000);
    const r = measureSpeaker(frames.map(f => f.levels), m.id, ids, p.learned.noiseFloorDb, nm);
    if (r.ok) {
      p.learned.bleedDb[m.id] = { ...(p.learned.bleedDb[m.id] ?? {}), ...r.bleedRow };
      p.learned.speechDb[m.id] = r.speechDb!;
      smartSwitch.profileChanged();
      await smartSwitch.save();
    }
    const nextMic = enabled[enabled.findIndex(x => x.id === m.id) + 1];
    return {
      step: 'speaker', mic: m.name, ok: r.ok, voicedTicks: r.voicedFrames,
      speechDb: r.speechDb === null ? null : r1(r.speechDb),
      bleedIntoOthersDb: Object.fromEntries(Object.entries(r.bleedRow).map(([id, v]) => [nm[id], r1(v)])),
      suggestedMic: r.suggestedMic ? nm[r.suggestedMic] : null,
      warnings: r.warnings,
      next: !r.ok ? 'Redo this step (check the mic is on and mapped to the right channel).'
        : nextMic ? `Next: only ${nextMic.name} talks — speaker step for "${nextMic.name}".`
        : 'Next: everyone talks at once — the together step.',
      nextMic: r.ok ? (nextMic?.name ?? null) : m.name,
    };
  }

  // together
  const who = (people && people.length ? people.map(n => micByName(p, n)) : enabled).map(m => m.id);
  if (who.length < 2) throw new Error('The together step needs at least two people.');
  const frames = await smartSwitch.record((seconds ?? 10) * 1000);
  const r = checkTogether(p, frames, who);
  if (r.relaxed.length) { smartSwitch.profileChanged(); await smartSwitch.save(); }
  return {
    step: 'together', ok: r.hidden.length === 0, people: who.map(id => nm[id]), frames: frames.length,
    detectedShare: Object.fromEntries(Object.entries(r.detectedShare).map(([id, v]) => [nm[id], `${Math.round(v * 100)}%`])),
    correctShotShare: `${Math.round(r.correctShotShare * 100)}%`,
    result: r.hidden.length ? 'CHECK' : 'GOOD',
    warnings: r.warnings,
    next: 'Review the summary, then switch on (simulate first if you want to watch its decisions without cutting).',
  };
}

// ------------------------------- switching ----------------------------------

export async function switchOn(simulate: boolean): Promise<string> {
  const p = smartSwitch.profile();
  const problems = profileProblems(p);
  if (problems.length) throw new Error(`Can't start: ${problems.join(' ')}`);
  const err = await smartSwitch.start({ simulate });
  if (err) throw new Error(err);
  const learnedPairs = Object.values(p.learned.bleedDb).reduce((n, row) => n + Object.keys(row).length, 0);
  const total = p.mics.filter(m => m.enabled).length;
  return `Smart switch ${simulate ? 'SIMULATING (no cuts sent)' : 'ON'} — profile "${p.name}", speed ${p.speed}, ${total} mics, ${p.cameras.length} cameras, transition ${p.rules.transition}.`
    + `\nBleed learned for ${learnedPairs} of ${total * (total - 1)} mic pairs${learnedPairs === 0 ? ' — calibrate for best results (falling back to ignoring weak mics)' : ''}.`;
}

export function switchOff(): string {
  if (!smartSwitch.isSwitching()) return 'The smart switch is not running.';
  const sim = smartSwitch.isSimulating();
  const r = smartSwitch.stop();
  return `Smart switch stopped after ${r.seconds}s with ${r.cuts} ${sim ? 'simulated ' : ''}cuts.`;
}
