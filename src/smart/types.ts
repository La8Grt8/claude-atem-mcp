// ---------------------------------------------------------------------------
// Smart switch — shared types, defaults and speed presets.
//
// A profile describes one show setup: which mics exist (and where their audio
// comes from), which ATEM inputs are cameras and who is visible on each, the
// cutting rules, and what has been learned about each mic (noise floor, and
// how much each person's voice bleeds into every other mic).
// ---------------------------------------------------------------------------

/** Where a mic's level comes from. */
export type MicSource =
  | { kind: 'atem'; input: number }          // ATEM Fairlight input (pre-fader level)
  | { kind: 'device'; channel: number };     // channel (1-based) of the USB mixer device

export interface Mic {
  id: string;            // stable id, e.g. "m1"
  name: string;          // person's name, e.g. "Rob"
  source: MicSource;
  enabled: boolean;
  /** Manual voice threshold in dBFS; null = automatic (noise floor + margin). */
  manualThresholdDb: number | null;
}

export interface Camera {
  input: number;         // ATEM input number
  name: string;
  /** Mic ids of the people visible in this shot. All mics = the wide shot. */
  mics: string[];
}

export type SilenceAction = 'stay' | 'wide' | 'camera';
export type SpeedKey = 'very_fast' | 'fast' | 'normal' | 'calm' | 'custom';

export interface Rules {
  /** No shot is shorter than this. */
  minShotMs: number;
  /** A new desired shot must hold this long before we cut (filters noises). */
  switchDelayMs: number;
  /** Continuous voice needed to count as talking. */
  attackMs: number;
  /** Silence needed to count as done talking. */
  releaseMs: number;

  /** From how many simultaneous talkers we go to a camera that shows them all. */
  groupCount: number;
  /** How long they must talk together first. */
  groupConfirmMs: number;

  silenceAction: SilenceAction;
  silenceCamera: number | null;     // ATEM input, used when silenceAction = 'camera'
  silenceMs: number;

  /** After someone talks this long without a break, briefly show the wide. 0 = off. */
  varietyMs: number;
  /** How long the variety cutaway stays up. */
  varietyHoldMs: number;

  /** After a manual cut (from the panel, software control or a tool) pause this long. */
  manualHoldMs: number;
  /** Don't cut while program is something that isn't a configured camera (logo, black, media). */
  respectOtherSources: boolean;

  transition: 'cut' | 'auto';
  me: number;

  /** Voice = noise floor + this many dB (automatic threshold). */
  autoMarginDb: number;
  /** A mic is its own voice only if louder than the expected bleed by this much. */
  bleedMarginDb: number;
  /** Until bleed is learned, ignore mics this far below the loudest. null = off. */
  weakMicRejectDb: number | null;
  /** Keep refining noise floors and bleed while live (only when one person clearly talks alone). */
  adaptive: boolean;
}

export interface Learned {
  /** Noise floor per mic id (dBFS). */
  noiseFloorDb: Record<string, number>;
  /** bleed[src][dst] = dB of src's voice that reaches dst's mic, relative to src's own mic. */
  bleedDb: Record<string, Record<string, number>>;
  /** Typical speaking level per mic id (dBFS), from calibration. */
  speechDb: Record<string, number>;
}

export interface Profile {
  name: string;
  speed: SpeedKey;
  mics: Mic[];
  cameras: Camera[];
  rules: Rules;
  learned: Learned;
}

export interface SmartSwitchConfig {
  version: 1;
  activeProfile: string;
  /** ffmpeg avfoundation audio device (name or index) for 'device' mics. */
  audioDevice: string | null;
  profiles: Profile[];
}

// ----------------------------- presets --------------------------------------

type Timing = Pick<Rules, 'minShotMs' | 'switchDelayMs' | 'attackMs' | 'releaseMs'>;

export const SPEED_PRESETS: Record<Exclude<SpeedKey, 'custom'>, Timing> = {
  very_fast: { minShotMs: 1200, switchDelayMs: 150, attackMs: 150, releaseMs: 600 },
  fast:      { minShotMs: 2000, switchDelayMs: 250, attackMs: 200, releaseMs: 900 },
  normal:    { minShotMs: 3000, switchDelayMs: 400, attackMs: 300, releaseMs: 1300 },
  calm:      { minShotMs: 5000, switchDelayMs: 700, attackMs: 500, releaseMs: 2000 },
};

export const DEFAULT_RULES: Rules = {
  ...SPEED_PRESETS.normal,
  groupCount: 2,
  groupConfirmMs: 2500,
  silenceAction: 'stay',
  silenceCamera: null,
  silenceMs: 4000,
  varietyMs: 45000,
  varietyHoldMs: 3000,
  manualHoldMs: 8000,
  respectOtherSources: true,
  transition: 'cut',
  me: 0,
  autoMarginDb: 12,
  bleedMarginDb: 6,
  weakMicRejectDb: 10,
  adaptive: true,
};

/** Floor used for silence / missing data, in dBFS. */
export const SILENCE_DB = -100;

export function emptyLearned(): Learned {
  return { noiseFloorDb: {}, bleedDb: {}, speechDb: {} };
}

export function newProfile(name: string): Profile {
  return { name, speed: 'normal', mics: [], cameras: [], rules: { ...DEFAULT_RULES }, learned: emptyLearned() };
}

export function applySpeed(profile: Profile, speed: SpeedKey): void {
  profile.speed = speed;
  if (speed !== 'custom') Object.assign(profile.rules, SPEED_PRESETS[speed]);
}

/** Configuration problems that stop auto switching from making sense. */
export function profileProblems(p: Profile): string[] {
  const out: string[] = [];
  const mics = p.mics.filter(m => m.enabled);
  if (mics.length === 0) out.push('No mics are enabled.');
  if (p.cameras.length === 0) out.push('No ATEM input is set up as a camera.');
  else if (p.cameras.every(c => c.mics.length === 0)) out.push('No camera has any mics assigned: auto switching won\'t know who to show.');
  const seen = new Set(p.cameras.flatMap(c => c.mics));
  const orphan = mics.filter(m => !seen.has(m.id)).map(m => m.name);
  if (orphan.length) out.push(`${orphan.join(', ')}: not on any camera, so their voice won't trigger cuts.`);
  const chans = new Map<string, number>();
  for (const m of mics) {
    const k = m.source.kind === 'atem' ? `atem:${m.source.input}` : `device:${m.source.channel}`;
    chans.set(k, (chans.get(k) ?? 0) + 1);
  }
  for (const [k, n] of chans) if (n > 1) out.push(`Several mics use ${k.replace(':', ' ')}.`);
  if (p.rules.silenceAction === 'camera' && !p.cameras.some(c => c.input === p.rules.silenceCamera)) {
    out.push('Silence action is "camera" but silence_camera is not one of the cameras.');
  }
  return out;
}

// ----------------------------- dB helpers -----------------------------------

/** Power sum of dB values: 10·log10(Σ 10^(x/10)). */
export function dbSum(values: number[]): number {
  if (values.length === 0) return SILENCE_DB;
  let s = 0;
  for (const v of values) s += Math.pow(10, v / 10);
  return s > 0 ? 10 * Math.log10(s) : SILENCE_DB;
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const a = [...values].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
