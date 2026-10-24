// ---------------------------------------------------------------------------
// Smart switch runtime — owns the tick loop that reads mic levels (ATEM
// Fairlight inputs and/or a USB mixer), feeds the engine, and, when switching
// is on, sends its cuts to the ATEM. Also records frames for calibration.
//
// Metering and switching are separate: meters run as soon as anything needs
// levels (status, calibration, switching); cuts are only sent while switching
// is on, and never in simulation mode.
// ---------------------------------------------------------------------------

import { DeviceMeter } from './audio-device.js';
import { SwitchEngine, Decision } from './engine.js';
import { TimedFrame } from './calibration.js';
import { CONFIG_PATH, loadConfig, saveConfig } from './profile-store.js';
import { Profile, SILENCE_DB, SmartSwitchConfig, newProfile } from './types.js';
import {
  getAtem, getInputName, isAtemConnected, isAutoSwitchRunning, isLevelTrackingActive,
  onSourceLevel, setOtherSwitcherCheck, startAudioLevelTracking,
} from '../services/atem-connection.js';

const TICK_MS = 50;
const ATEM_LEVEL_STALE_MS = 1000;
const LEARN_SAVE_MS = 15000;
const CUT_LOG_SIZE = 100;

export interface CutLogEntry {
  at: string;
  input: number;
  name: string;
  reason: string;
  source: 'auto' | 'manual' | 'simulated';
}

class SmartSwitchController {
  config: SmartSwitchConfig = loadConfig();
  private engine = new SwitchEngine(this.profile());
  private device = new DeviceMeter();

  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeAtem: (() => void) | null = null;
  private atemMax = new Map<number, number>();
  private atemLastAt = new Map<number, number>();

  private switching = false;
  private simulate = false;
  private simProgram: number | null = null;
  private startedAt = 0;
  private lastDecision: Decision | null = null;
  private lastProgram: number | null = null;
  private lastProgramAt = 0;
  private onAirMs = new Map<number, number>();
  private cutLog: CutLogEntry[] = [];
  private recorders = new Set<(f: TimedFrame) => void>();
  private lastLearnSave = 0;
  private deviceError: string | null = null;

  constructor() {
    setOtherSwitcherCheck(() => this.switching);
  }

  // ------------------------------- profiles ---------------------------------

  profile(): Profile {
    return this.config.profiles.find(p => p.name === this.config.activeProfile) ?? this.config.profiles[0];
  }

  async save(): Promise<void> {
    await saveConfig(this.config);
  }

  configPath(): string {
    return CONFIG_PATH;
  }

  /** Re-point the engine after the active profile or its mics/cameras changed. */
  profileChanged(): void {
    this.engine.setProfile(this.profile());
    if (this.timer) this.syncDevice().catch(() => undefined);
  }

  useProfile(name: string): void {
    if (!this.config.profiles.some(p => p.name === name)) throw new Error(`No profile named "${name}".`);
    this.config.activeProfile = name;
    this.engine = new SwitchEngine(this.profile());
    if (this.timer) this.syncDevice().catch(() => undefined);
  }

  createProfile(name: string, copyFrom?: string): Profile {
    if (this.config.profiles.some(p => p.name === name)) throw new Error(`Profile "${name}" already exists.`);
    const src = copyFrom ? this.config.profiles.find(p => p.name === copyFrom) : undefined;
    if (copyFrom && !src) throw new Error(`No profile named "${copyFrom}".`);
    const p: Profile = src ? { ...JSON.parse(JSON.stringify(src)), name } : newProfile(name);
    this.config.profiles.push(p);
    return p;
  }

  deleteProfile(name: string): void {
    if (this.config.profiles.length <= 1) throw new Error('There must be at least one profile.');
    const i = this.config.profiles.findIndex(p => p.name === name);
    if (i < 0) throw new Error(`No profile named "${name}".`);
    if (this.switching && name === this.config.activeProfile) throw new Error('Stop the smart switch before deleting the active profile.');
    this.config.profiles.splice(i, 1);
    if (this.config.activeProfile === name) this.useProfile(this.config.profiles[0].name);
  }

  // ------------------------------- meters -----------------------------------

  /** Start reading levels (idempotent). Throws if a USB-mixer mic can't be opened. */
  async ensureMeters(): Promise<void> {
    if (!this.unsubscribeAtem) {
      this.unsubscribeAtem = onSourceLevel((input, level) => {
        const prev = this.atemMax.get(input);
        if (prev === undefined || level > prev) this.atemMax.set(input, level);
        this.atemLastAt.set(input, Date.now());
      });
    }
    if (isAtemConnected() && !isLevelTrackingActive()) await startAudioLevelTracking();
    await this.syncDevice();
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stopMeters(): void {
    if (this.switching) return;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.device.stop();
    this.unsubscribeAtem?.();
    this.unsubscribeAtem = null;
  }

  metersRunning(): boolean {
    return this.timer !== null;
  }

  deviceStatus() {
    return { configured: this.config.audioDevice, ...this.device.status(), error: this.device.status().error ?? this.deviceError };
  }

  private needsDevice(): boolean {
    return this.profile().mics.some(m => m.enabled && m.source.kind === 'device');
  }

  private async syncDevice(): Promise<void> {
    const want = this.needsDevice() ? this.config.audioDevice : null;
    const st = this.device.status();
    if (!want) { if (st.running) this.device.stop(); return; }
    if (st.running && st.device === want) return;
    try {
      this.deviceError = null;
      await this.device.start(want);
    } catch (e) {
      this.deviceError = (e as Error).message;
      throw e;
    }
  }

  /** Record frames for `ms` (meters must be running). */
  record(ms: number): Promise<TimedFrame[]> {
    return new Promise(resolve => {
      const frames: TimedFrame[] = [];
      const rec = (f: TimedFrame) => frames.push(f);
      this.recorders.add(rec);
      setTimeout(() => { this.recorders.delete(rec); resolve(frames); }, ms);
    });
  }

  private readLevels(now: number): Record<string, number> {
    const p = this.profile();
    const dev = this.needsDevice() ? this.device.read() : [];
    const atemNow = new Map<number, number>();
    for (const [input, v] of this.atemMax) {
      if (now - (this.atemLastAt.get(input) ?? 0) <= ATEM_LEVEL_STALE_MS) atemNow.set(input, v / 100);
    }
    this.atemMax.clear();
    const out: Record<string, number> = {};
    for (const m of p.mics) {
      if (!m.enabled) continue;
      out[m.id] = m.source.kind === 'atem'
        ? (atemNow.get(m.source.input) ?? SILENCE_DB)
        : (dev[m.source.channel - 1] ?? SILENCE_DB);
    }
    return out;
  }

  // ------------------------------- switching --------------------------------

  isSwitching(): boolean { return this.switching; }
  isSimulating(): boolean { return this.simulate; }

  async start(opts: { simulate: boolean }): Promise<string> {
    if (this.switching) return 'The smart switch is already running.';
    if (isAutoSwitchRunning()) return 'The classic auto-switch is running. Stop it first with atem_auto_switch_off.';
    if (!opts.simulate && !isAtemConnected()) return 'Not connected to ATEM. Use atem_connect first, or start with simulate: true.';
    await this.ensureMeters();
    this.simulate = opts.simulate;
    this.simProgram = this.currentAtemProgram();
    this.engine = new SwitchEngine(this.profile());
    this.engine.notifyProgram(this.program(), Date.now());
    this.startedAt = Date.now();
    this.lastProgram = this.program();
    this.lastProgramAt = this.startedAt;
    this.onAirMs.clear();
    this.cutLog = [];
    this.switching = true;
    return '';
  }

  stop(): { seconds: number; cuts: number } {
    const r = { seconds: Math.round((Date.now() - this.startedAt) / 1000), cuts: this.cutLog.filter(c => c.source !== 'manual').length };
    this.switching = false;
    this.simulate = false;
    this.save().catch(e => console.error('[smart-switch] save failed:', e));
    return r;
  }

  releaseHold(): void {
    this.engine.releaseHold();
  }

  status() {
    const now = Date.now();
    const p = this.profile();
    const onAir = Object.fromEntries([...this.onAirMs].map(([input, ms]) => {
      const live = input === this.lastProgram && this.switching ? now - this.lastProgramAt : 0;
      return [this.label(input), Math.round((ms + live) / 1000)];
    }));
    return {
      switching: this.switching,
      simulate: this.simulate,
      profile: p.name,
      speed: p.speed,
      runningForSeconds: this.switching ? Math.round((now - this.startedAt) / 1000) : 0,
      program: this.program() === null ? null : this.label(this.program()!),
      decision: this.lastDecision,
      manualPauseRemainingS: Math.ceil(this.engine.holdRemainingMs(now) / 1000),
      mics: this.engine.status().map(s => ({
        name: s.name, level: round(s.levelDb), floor: round(s.floorDb), threshold: round(s.thresholdDb),
        expectedBleed: s.expectedBleedDb === null ? null : round(s.expectedBleedDb), ownVoice: s.ownVoice, talking: s.talking,
      })),
      onAirSeconds: onAir,
      recentCuts: this.cutLog.slice(-10),
      meters: { running: this.metersRunning(), atemLevels: isLevelTrackingActive(), device: this.deviceStatus() },
    };
  }

  cuts(): CutLogEntry[] {
    return [...this.cutLog];
  }

  private currentAtemProgram(): number | null {
    if (!isAtemConnected()) return null;
    try {
      return getAtem().state?.video?.mixEffects?.[this.profile().rules.me]?.programInput ?? null;
    } catch { return null; }
  }

  private program(): number | null {
    return this.simulate ? this.simProgram : this.currentAtemProgram();
  }

  private label(input: number): string {
    const cam = this.profile().cameras.find(c => c.input === input);
    if (cam) return `${cam.name} (${input})`;
    try { return `${getInputName(input)} (${input})`; } catch { return `Input ${input}`; }
  }

  private tick(): void {
    const now = Date.now();
    const levels = this.readLevels(now);
    for (const r of this.recorders) r({ t: now, levels });

    const program = this.program();
    if (this.switching && program !== this.lastProgram) {
      if (this.lastProgram !== null) this.onAirMs.set(this.lastProgram, (this.onAirMs.get(this.lastProgram) ?? 0) + now - this.lastProgramAt);
      const ours = this.cutLog.length > 0 && this.cutLog[this.cutLog.length - 1].input === program
        && now - Date.parse(this.cutLog[this.cutLog.length - 1].at) < 2000;
      if (!ours && program !== null) this.log(program, 'Cut from the ATEM / by hand', 'manual');
      this.lastProgram = program;
      this.lastProgramAt = now;
    }
    this.engine.notifyProgram(program, now);
    const d = this.engine.update(levels, now);
    this.lastDecision = d;

    if (this.switching && d.cutTo !== null) this.cut(d.cutTo, d.reason, now);

    if (this.engine.takeLearnedDirty() && now - this.lastLearnSave > LEARN_SAVE_MS) {
      this.lastLearnSave = now;
      this.save().catch(e => console.error('[smart-switch] save failed:', e));
    }
  }

  private cut(input: number, reason: string, now: number): void {
    this.engine.commandSent(input, now);
    if (this.simulate) {
      this.simProgram = input;
      this.log(input, reason, 'simulated');
      return;
    }
    if (!isAtemConnected()) return;
    const atem = getAtem();
    const { me, transition } = this.profile().rules;
    this.log(input, reason, 'auto');
    const p = transition === 'auto'
      ? atem.changePreviewInput(input, me).then(() => atem.autoTransition(me))
      : atem.changeProgramInput(input, me);
    p.catch((e: unknown) => console.error(`[smart-switch] cut to ${input} failed:`, e));
    console.error(`[smart-switch] → ${this.label(input)}: ${reason}`);
  }

  private log(input: number, reason: string, source: CutLogEntry['source']): void {
    this.cutLog.push({ at: new Date().toISOString(), input, name: this.label(input), reason, source });
    if (this.cutLog.length > CUT_LOG_SIZE) this.cutLog.shift();
  }
}

function round(x: number): number {
  return Math.round(x * 10) / 10;
}

export const smartSwitch = new SmartSwitchController();
