// ---------------------------------------------------------------------------
// Smart switch engine — decides which camera should be on air, from per-mic
// levels. Pure and clock-injected: no timers, no ATEM, no audio I/O, so the
// whole thing can be driven by recorded or synthetic levels in tests.
//
// Per tick, for every enabled mic:
//   1. envelope  — follows peaks instantly, holds briefly, then decays, so the
//                  dips between syllables don't read as silence
//   2. floor     — tracks background noise (falls fast, rises slowly, and only
//                  while the mic isn't carrying voice)
//   3. own voice — the envelope must clear the threshold (floor + margin, or a
//                  manual threshold) AND beat the bleed expected from everyone
//                  else currently loud: Σ(level_s + bleed[s][this]) + margin.
//                  Until a pair's bleed is learned, a mic far below the loudest
//                  is ignored instead (weakMicRejectDb).
//   4. talking   — own voice for attackMs starts a turn; releaseMs without it
//                  ends the turn.
//
// Then the chooser turns "who is talking" into a target camera (tightest shot
// that shows the talkers, a group/wide shot when several talk long enough,
// silence and variety rules), and the guards decide whether to cut now
// (confirm delay, minimum shot, manual-cut pause, non-camera sources).
// ---------------------------------------------------------------------------

import { Camera, Mic, Profile, SILENCE_DB, dbSum } from './types.js';

/** Tunables that aren't exposed as per-profile rules. */
export const ENGINE_CONSTANTS = {
  ENV_HOLD_MS: 120,
  ENV_DECAY_DB_S: 30,
  NOISE_FALL_TAU_MS: 300,
  NOISE_RISE_DB_S: 0.5,
  NOISE_MAX_DB: -25,
  /** Adaptive learning only when one person leads every other mic by this much… */
  CLEAR_LEAD_DB: 10,
  /** …and is this far above their own noise floor. */
  CLEAR_OVER_NOISE_DB: 20,
  /** Only learn bleed into a mic whose level is measurably above its floor. */
  BLEED_MEASURABLE_DB: 3,
  BLEED_TAU_MS: 8000,
  /** Learned bleed is never allowed above this (a mic can't hear someone better than its own person). */
  BLEED_CAP_DB: -1,
  /** Several talkers: one of them leading the others by this much counts as the speaker. */
  DOMINANCE_DB: 8,
  /** Minimum pause in the speaker's voice before a variety cutaway may land. */
  VARIETY_PAUSE_MS: 250,
};

export interface MicStatus {
  id: string;
  name: string;
  levelDb: number;
  envelopeDb: number;
  floorDb: number;
  thresholdDb: number;
  expectedBleedDb: number | null;
  ownVoice: boolean;
  talking: boolean;
}

export interface Decision {
  /** Input to cut to now, or null to stay. */
  cutTo: number | null;
  /** The shot the engine wants (may differ from cutTo while a guard holds it back). */
  target: number | null;
  /** Human-readable reason for the target / the hold. */
  reason: string;
  /** What is holding the cut back, if anything. */
  holding: string | null;
  talkers: string[];
}

interface MicRuntime {
  env: number;
  envHoldUntil: number;
  floor: number | null;
  level: number;
  ownVoice: boolean;
  aboveMs: number;
  belowMs: number;
  talking: boolean;
  talkStart: number;
  lastVoiceAt: number;
  expected: number | null;
  threshold: number;
}

export class SwitchEngine {
  private profile: Profile;
  private mic = new Map<string, MicRuntime>();
  private lastNow: number | null = null;

  private program: number | null = null;
  private lastCommanded: number | null = null;
  private lastCutAt = -Infinity;
  private holdUntil = -Infinity;

  private pendingTarget: number | null = null;
  private pendingSince = 0;
  private groupSince: number | null = null;
  private silentSince: number | null = null;
  private varietyUntil = -Infinity;

  /** Set when adaptive learning changed profile.learned since the last call to takeLearnedDirty(). */
  private learnedDirty = false;
  private lastStatus: MicStatus[] = [];

  constructor(profile: Profile, private readonly k = ENGINE_CONSTANTS) {
    this.profile = profile;
  }

  setProfile(profile: Profile): void {
    this.profile = profile;
    for (const id of [...this.mic.keys()]) if (!profile.mics.some(m => m.id === id)) this.mic.delete(id);
  }

  /** Release the manual-cut pause so the engine decides again right away. */
  releaseHold(): void {
    this.holdUntil = -Infinity;
  }

  takeLearnedDirty(): boolean {
    const d = this.learnedDirty;
    this.learnedDirty = false;
    return d;
  }

  status(): MicStatus[] {
    return this.lastStatus;
  }

  holdRemainingMs(now: number): number {
    return Math.max(0, this.holdUntil - now);
  }

  /**
   * Tell the engine what is on program. Call every tick with the ATEM's state.
   * A change the engine didn't command is a manual cut and starts the pause.
   */
  notifyProgram(input: number | null, now: number): void {
    if (input === this.program) return;
    const first = this.program === null;
    this.program = input;
    if (first) return;
    if (input !== this.lastCommanded) {
      this.holdUntil = now + this.profile.rules.manualHoldMs;
      this.lastCutAt = now;
      this.lastCommanded = input;
      this.pendingTarget = null;
    }
  }

  /** The engine's cut was sent; record it so its echo isn't taken for a manual cut. */
  commandSent(input: number, now: number): void {
    this.lastCommanded = input;
    this.lastCutAt = now;
    this.pendingTarget = null;
  }

  // ------------------------------- per tick ---------------------------------

  update(levels: Record<string, number>, now: number): Decision {
    const dt = this.lastNow === null ? 0 : Math.max(0, Math.min(1000, now - this.lastNow));
    this.lastNow = now;
    const rules = this.profile.rules;
    const mics = this.profile.mics.filter(m => m.enabled);

    // 1–2. envelope + floor + threshold
    for (const m of mics) {
      const x = levels[m.id] ?? SILENCE_DB;
      const r = this.runtime(m, x);
      r.level = x;
      if (x >= r.env) {
        r.env = x;
        r.envHoldUntil = now + this.k.ENV_HOLD_MS;
      } else if (now > r.envHoldUntil) {
        r.env = Math.max(x, r.env - this.k.ENV_DECAY_DB_S * dt / 1000);
      }
      if (r.floor === null) r.floor = x;
      else if (x < r.floor) r.floor += (x - r.floor) * Math.min(1, dt / this.k.NOISE_FALL_TAU_MS);
      else if (!r.ownVoice && x < r.floor + rules.autoMarginDb) {
        r.floor = Math.min(x, r.floor + this.k.NOISE_RISE_DB_S * dt / 1000);
      }
      r.floor = Math.min(r.floor, this.k.NOISE_MAX_DB);
      r.threshold = m.manualThresholdDb ?? (r.floor + rules.autoMarginDb);
    }

    // 3. own voice vs expected bleed
    const loud = mics.filter(m => this.mic.get(m.id)!.env > this.mic.get(m.id)!.threshold);
    for (const m of mics) {
      const r = this.mic.get(m.id)!;
      const isLoud = r.env > r.threshold;
      if (!isLoud) { r.ownVoice = false; r.expected = null; continue; }
      const contributions: number[] = [];
      let usedFallback = false;
      for (const s of loud) {
        if (s.id === m.id) continue;
        const b = this.bleed(s.id, m.id);
        if (b === null) continue;
        if (b.fallback) usedFallback = true;
        contributions.push(this.mic.get(s.id)!.env + b.db);
      }
      r.expected = contributions.length ? dbSum(contributions) : null;
      const margin = usedFallback ? 0 : rules.bleedMarginDb;
      r.ownVoice = r.expected === null || r.env > r.expected + margin;
    }

    // 4. talking state
    for (const m of mics) {
      const r = this.mic.get(m.id)!;
      if (r.ownVoice) {
        r.lastVoiceAt = now;
        r.belowMs = 0;
        r.aboveMs += dt;
        if (!r.talking && r.aboveMs >= rules.attackMs) { r.talking = true; r.talkStart = now - r.aboveMs; }
      } else {
        r.aboveMs = 0;
        r.belowMs += dt;
        if (r.talking && r.belowMs >= rules.releaseMs) r.talking = false;
      }
    }

    if (rules.adaptive) this.adapt(mics, dt);

    this.lastStatus = mics.map(m => {
      const r = this.mic.get(m.id)!;
      return {
        id: m.id, name: m.name, levelDb: r.level, envelopeDb: r.env, floorDb: r.floor ?? SILENCE_DB,
        thresholdDb: r.threshold, expectedBleedDb: r.expected, ownVoice: r.ownVoice, talking: r.talking,
      };
    });

    return this.decide(mics, now);
  }

  // ------------------------------- chooser ----------------------------------

  private decide(mics: Mic[], now: number): Decision {
    const rules = this.profile.rules;
    const cams = this.profile.cameras.filter(c => c.mics.length > 0);
    const onCamera = new Set(cams.flatMap(c => c.mics));
    const talkersAll = mics.filter(m => this.mic.get(m.id)!.talking);
    const talkers = talkersAll.filter(m => onCamera.has(m.id));
    const names = talkers.map(m => m.name);
    const base = { talkers: names };

    // group / silence timers
    if (talkers.length >= rules.groupCount && rules.groupCount >= 2) this.groupSince ??= now;
    else this.groupSince = null;
    if (talkers.length === 0) this.silentSince ??= now;
    else this.silentSince = null;

    let target: number | null = null;
    let reason: string;

    if (talkers.length === 0) {
      const silentFor = now - (this.silentSince ?? now);
      reason = talkersAll.length ? 'Talking on a mic that isn\'t on any camera' : 'Silence';
      if (silentFor >= rules.silenceMs && talkersAll.length === 0) {
        if (rules.silenceAction === 'wide') { target = this.wide(cams)?.input ?? null; reason = 'Silence: wide shot'; }
        else if (rules.silenceAction === 'camera' && rules.silenceCamera !== null) {
          target = rules.silenceCamera; reason = 'Silence: chosen camera';
        }
      }
    } else if (this.groupSince !== null && now - this.groupSince >= rules.groupConfirmMs) {
      const cam = this.tightest(cams, talkers.map(t => t.id)) ?? this.wide(cams);
      target = cam?.input ?? null;
      reason = `${talkers.length} talking: ${names.join(', ')}`;
    } else {
      let speaker: Mic | null = talkers.length === 1 ? talkers[0] : this.dominant(talkers);
      if (!speaker) {
        // several talking, no group shot yet: keep a shot that already shows one of them
        const cur = cams.find(c => c.input === this.program);
        if (cur && talkers.some(t => cur.mics.includes(t.id))) {
          return this.hold(null, `${talkers.length} talking on different cameras: keeping the current shot`, base);
        }
        speaker = this.loudest(talkers);
      }
      const cam = this.tightest(cams, [speaker.id]);
      target = cam?.input ?? null;
      reason = talkers.length === 1 ? `${speaker.name} talking` : `${speaker.name} is leading the conversation`;

      // variety: long monologue on the same shot → brief cutaway to the wide, landing in a pause
      const r = this.mic.get(speaker.id)!;
      const wide = this.wide(cams);
      if (now < this.varietyUntil && wide) {
        target = wide.input;
        reason = `Variety: ${speaker.name} has been on for a while`;
      } else if (rules.varietyMs > 0 && wide && target !== null && target !== wide.input
        && this.program === target && now - r.talkStart >= rules.varietyMs
        && now - this.lastCutAt >= rules.varietyMs
        && !r.ownVoice && now - r.lastVoiceAt >= this.k.VARIETY_PAUSE_MS) {
        this.varietyUntil = now + Math.max(rules.varietyHoldMs, rules.minShotMs);
        target = wide.input;
        reason = `Variety: ${speaker.name} has been on for ${Math.round((now - r.talkStart) / 1000)} s`;
      }
    }

    // already showing an equally tight shot of the same people → no cut
    if (target !== null && this.program !== null && target !== this.program) {
      const want = cams.find(c => c.input === target);
      const cur = cams.find(c => c.input === this.program);
      if (want && cur && cur.mics.length === want.mics.length
        && talkers.length > 0 && talkers.every(t => cur.mics.includes(t.id))) {
        target = this.program;
      }
    }

    return this.guard(target, reason, base, now);
  }

  private guard(target: number | null, reason: string, base: { talkers: string[] }, now: number): Decision {
    const rules = this.profile.rules;
    if (target === null || target === this.program) {
      this.pendingTarget = null;
      return { cutTo: null, target, reason, holding: null, ...base };
    }
    if (rules.respectOtherSources && this.program !== null
      && !this.profile.cameras.some(c => c.input === this.program)) {
      return this.hold(target, reason, base, `Program is input ${this.program}, which isn't a camera: waiting until you cut back to a camera`);
    }
    if (now < this.holdUntil) {
      return this.hold(target, reason, base, `Pause after manual cut: ${Math.ceil((this.holdUntil - now) / 1000)} s`);
    }
    if (target !== this.pendingTarget) {
      this.pendingTarget = target;
      this.pendingSince = now;
    }
    if (now - this.pendingSince < rules.switchDelayMs) return this.hold(target, reason, base, 'Confirming the new shot');
    if (now - this.lastCutAt < rules.minShotMs) return this.hold(target, reason, base, 'Minimum time per shot');
    return { cutTo: target, target, reason, holding: null, ...base };
  }

  private hold(target: number | null, reason: string, base: { talkers: string[] }, holding: string | null = null): Decision {
    return { cutTo: null, target, reason, holding, ...base };
  }

  // ------------------------------- helpers ----------------------------------

  private runtime(m: Mic, x: number): MicRuntime {
    let r = this.mic.get(m.id);
    if (!r) {
      r = {
        env: x, envHoldUntil: 0, floor: this.profile.learned.noiseFloorDb[m.id] ?? null, level: x,
        ownVoice: false, aboveMs: 0, belowMs: 0, talking: false, talkStart: 0, lastVoiceAt: -Infinity,
        expected: null, threshold: 0,
      };
      this.mic.set(m.id, r);
    }
    return r;
  }

  /** Learned bleed s→d, or the weak-mic fallback (flagged), or null when neither applies. */
  private bleed(src: string, dst: string): { db: number; fallback: boolean } | null {
    const learned = this.profile.learned.bleedDb[src]?.[dst];
    if (learned !== undefined) return { db: learned, fallback: false };
    const reject = this.profile.rules.weakMicRejectDb;
    return reject === null ? null : { db: -reject, fallback: true };
  }

  /** Refine noise floors and bleed only while one person clearly talks alone. */
  private adapt(mics: Mic[], dt: number): void {
    if (dt <= 0 || mics.length < 2) return;
    // "Clearly alone" is judged on raw levels, not on ownVoice: before the bleed
    // is learned, a neighbour's bleed can itself pass as voice.
    const s = mics.reduce((a, b) => (this.mic.get(b.id)!.level > this.mic.get(a.id)!.level ? b : a));
    const rs = this.mic.get(s.id)!;
    if (!rs.ownVoice) return;
    if (rs.level - (rs.floor ?? SILENCE_DB) < this.k.CLEAR_OVER_NOISE_DB) return;
    for (const m of mics) {
      if (m.id === s.id) continue;
      if (rs.level - this.mic.get(m.id)!.level < this.k.CLEAR_LEAD_DB) return;
    }
    const learned = this.profile.learned;
    for (const d of mics) {
      if (d.id === s.id) continue;
      const rd = this.mic.get(d.id)!;
      if (rd.level - (rd.floor ?? SILENCE_DB) < this.k.BLEED_MEASURABLE_DB) continue;
      const measured = Math.min(this.k.BLEED_CAP_DB, rd.level - rs.level);
      const row = (learned.bleedDb[s.id] ??= {});
      const old = row[d.id];
      row[d.id] = old === undefined ? measured : old + (measured - old) * Math.min(1, dt / this.k.BLEED_TAU_MS);
      this.learnedDirty = true;
    }
  }

  /** Camera that shows all of `ids` with the fewest people (ties: lowest input). */
  private tightest(cams: Camera[], ids: string[]): Camera | null {
    let best: Camera | null = null;
    for (const c of cams) {
      if (!ids.every(id => c.mics.includes(id))) continue;
      if (!best || c.mics.length < best.mics.length || (c.mics.length === best.mics.length && c.input < best.input)) best = c;
    }
    return best;
  }

  /** The camera with the most people in it. */
  private wide(cams: Camera[]): Camera | null {
    let best: Camera | null = null;
    for (const c of cams) {
      if (!best || c.mics.length > best.mics.length || (c.mics.length === best.mics.length && c.input < best.input)) best = c;
    }
    return best;
  }

  private loudest(ms: Mic[]): Mic {
    return ms.reduce((a, b) => (this.mic.get(b.id)!.env > this.mic.get(a.id)!.env ? b : a));
  }

  private dominant(ms: Mic[]): Mic | null {
    const sorted = [...ms].sort((a, b) => this.mic.get(b.id)!.env - this.mic.get(a.id)!.env);
    if (sorted.length < 2) return sorted[0] ?? null;
    const lead = this.mic.get(sorted[0].id)!.env - this.mic.get(sorted[1].id)!.env;
    return lead >= this.k.DOMINANCE_DB ? sorted[0] : null;
  }
}
