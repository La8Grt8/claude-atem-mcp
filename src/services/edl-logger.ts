// ---------------------------------------------------------------------------
// EDL logger — records every program change on an M/E bus with timecode and
// writes a CMX 3600 EDL that DaVinci Resolve can conform against separately
// recorded camera files (for switchers without ISO recording, e.g. Constellation 4K).
//
// The logger listens to ATEM state changes, so it captures switches made from
// ANY source: hardware panel, ATEM Software Control, Claude, or auto-switch.
// The EDL (and a JSONL journal) are rewritten after every event, so nothing is
// lost if the app or server stops unexpectedly.
// ---------------------------------------------------------------------------
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Enums } from 'atem-connection';

/** Minimal surface of the Atem object the logger needs (makes it testable). */
export interface AtemLike extends EventEmitter {
  state?: any;
  requestTime(): Promise<void>;
}

export interface FrameRate {
  base: number;   // integer timecode base (24, 25, 30, 50, 60)
  real: number;   // actual frames per second (e.g. 29.97)
  label: string;
}

export type TcSource = 'atem' | 'clock';

interface EdlEvent {
  input: number;
  frame: number;                  // timecode in absolute frames
  transition: 'C' | 'D';
  duration: number;               // transition length in frames (0 for cuts)
  reel?: string;
  name?: string;
}

interface Marker { frame: number; note: string; }

// ----------------------------- timecode math --------------------------------

export function frameRateFromVideoMode(mode: number | undefined): FrameRate {
  const name = mode !== undefined ? (Enums.VideoMode as any)[mode] as string : undefined;
  const m = name?.match(/([pi])(\d{2,4})/);
  if (!m) return { base: 30, real: 30000 / 1001, label: '29.97 (assumed)' };
  const interlaced = m[1] === 'i';
  const code = m[2];
  const table: Record<string, FrameRate> = {
    '2398': { base: 24, real: 24000 / 1001, label: '23.976' },
    '24': { base: 24, real: 24, label: '24' },
    '25': { base: 25, real: 25, label: '25' },
    '2997': { base: 30, real: 30000 / 1001, label: '29.97' },
    '30': { base: 30, real: 30, label: '30' },
    '50': { base: 50, real: 50, label: '50' },
    '5000': { base: 50, real: 50, label: '50' },
    '5994': { base: 60, real: 60000 / 1001, label: '59.94' },
    '60': { base: 60, real: 60, label: '60' },
  };
  let fr = table[code] ?? { base: 30, real: 30000 / 1001, label: '29.97 (assumed)' };
  if (interlaced) { // interlaced modes are named by field rate; timecode runs at frame rate
    fr = code === '50' ? table['25'] : table['2997'];
  }
  return fr;
}

function dropPerMinute(base: number): number { return base === 60 ? 4 : 2; }

export function tcToFrames(h: number, m: number, s: number, f: number, base: number, df: boolean): number {
  let total = ((h * 3600 + m * 60 + s) * base) + f;
  if (df) {
    const mins = h * 60 + m;
    total -= dropPerMinute(base) * (mins - Math.floor(mins / 10));
  }
  return total;
}

export function framesToTc(frames: number, base: number, df: boolean): string {
  const day = tcToFrames(24, 0, 0, 0, base, df);
  let n = ((Math.round(frames) % day) + day) % day;
  if (df) {
    const d = dropPerMinute(base);
    const per10 = base * 600 - d * 9;
    const perMin = base * 60 - d;
    const tens = Math.floor(n / per10);
    const rem = n % per10;
    n += d * 9 * tens + (rem > d ? d * Math.floor((rem - d) / perMin) : 0);
  }
  const f = n % base;
  const totalSec = Math.floor(n / base);
  const s = totalSec % 60, m = Math.floor(totalSec / 60) % 60, h = Math.floor(totalSec / 3600) % 24;
  const p = (x: number) => String(x).padStart(2, '0');
  // CMX 3600 uses ':' throughout; drop-frame is declared by the FCM header line.
  return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`;
}

export function parseTc(tc: string, base: number, df: boolean): number {
  const parts = tc.split(/[:;.]/).map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) throw new Error(`Invalid timecode "${tc}" — use HH:MM:SS:FF`);
  return tcToFrames(parts[0], parts[1], parts[2], parts[3], base, df);
}

// ------------------------------- the logger ---------------------------------

export interface EdlStartOptions {
  title?: string;
  me?: number;
  outputDir?: string;
  tcSource?: TcSource;
  dropFrame?: boolean;
  recordStartTc?: string;
  reelNames?: Record<string, string>;
}

const BLACK_INPUT = 10010;

export class EdlLogger {
  private atem: AtemLike | null = null;
  private me = 0;
  private title = '';
  private files = { edl: '', markers: '', json: '' };
  private fr: FrameRate = { base: 30, real: 30000 / 1001, label: '29.97' };
  private df = true;
  private tcSource: TcSource = 'atem';
  private tcNote = '';
  private anchor: { frames: number; ms: number } | null = null;
  private events: EdlEvent[] = [];
  private markers: Marker[] = [];
  private pending: { to: number; startFrame: number; rate: number; endedAt?: number; consumed?: boolean } | null = null;
  private reelOverrides: Record<string, string> = {};
  private recStart = 0;
  private startedAt: Date | null = null;
  private endFrame: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private onState = (state: any, paths: string[]) => this.handleState(state, paths);
  private onTime = (t: any) => this.handleTime(t);

  get active(): boolean { return this.atem !== null; }

  async start(atem: AtemLike, opts: EdlStartOptions = {}): Promise<string> {
    if (this.active) throw new Error('EDL logging is already running — stop it first.');
    const state = atem.state;
    this.me = opts.me ?? 0;
    const meState = state?.video?.mixEffects?.[this.me];
    if (!meState) throw new Error(`M/E ${this.me + 1} not found on this switcher.`);

    this.fr = frameRateFromVideoMode(state?.settings?.videoMode);
    this.df = opts.dropFrame ?? (this.fr.real % 1 !== 0 && (this.fr.base === 30 || this.fr.base === 60));
    this.reelOverrides = opts.reelNames ?? {};
    this.title = opts.title?.trim() || 'ATEM Show';
    this.events = []; this.markers = []; this.pending = null; this.anchor = null; this.endFrame = null;
    this.startedAt = new Date();
    this.atem = atem;

    // Timecode source: the switcher's own clock if it answers, otherwise the Mac's time of day.
    this.tcSource = opts.tcSource ?? 'atem';
    this.tcNote = '';
    if (this.tcSource === 'atem') {
      atem.on('updatedTime', this.onTime);
      await atem.requestTime().catch(() => undefined);
      const t0 = Date.now();
      while (!this.anchor && Date.now() - t0 < 1500) await new Promise(r => setTimeout(r, 50));
      if (this.anchor) {
        this.timer = setInterval(() => { atem.requestTime().catch(() => undefined); }, 10000);
      } else {
        atem.off('updatedTime', this.onTime);
        this.tcSource = 'clock';
        this.tcNote = 'Switcher did not report timecode — fell back to Mac time-of-day.';
      }
    }

    this.recStart = parseTc(opts.recordStartTc ?? '01:00:00:00', this.fr.base, this.df);

    const dir = opts.outputDir ?? path.join(os.homedir(), 'Movies', 'ATEM EDLs');
    await fs.mkdir(dir, { recursive: true });
    const d = this.startedAt, p2 = (x: number) => String(x).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
    const slug = this.title.replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_').slice(0, 60) || 'ATEM_Show';
    const base = path.join(dir, `${slug}_${stamp}`);
    this.files = { edl: `${base}.edl`, markers: `${base}_markers.edl`, json: `${base}.json` };

    atem.on('stateChanged', this.onState);
    this.pushEvent(meState.programInput, this.now(), 'C', 0);
    await this.flush();
    return this.files.edl;
  }

  async stop(): Promise<{ edl: string; markers: string | null; events: number; length: string }> {
    if (!this.atem) throw new Error('EDL logging is not running.');
    this.endFrame = this.now();
    this.atem.off('stateChanged', this.onState);
    this.atem.off('updatedTime', this.onTime);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
    this.atem = null;
    return {
      edl: this.files.edl,
      markers: this.markers.length ? this.files.markers : null,
      events: this.events.length,
      length: framesToTc(this.endFrame - this.events[0].frame, this.fr.base, false),
    };
  }

  async addMarker(note: string): Promise<string> {
    if (!this.atem) throw new Error('EDL logging is not running.');
    const frame = this.now();
    this.markers.push({ frame, note });
    await this.flush();
    return this.recTc(frame);
  }

  status() {
    return {
      active: this.active,
      title: this.title,
      me: this.me + 1,
      frameRate: this.fr.label,
      dropFrame: this.df,
      timecodeSource: this.tcSource,
      note: this.tcNote || undefined,
      currentTimecode: this.active ? framesToTc(this.now(), this.fr.base, this.df) : undefined,
      events: this.events.length,
      markers: this.markers.length,
      edlFile: this.files.edl || undefined,
    };
  }

  // ------------------------------ internals ---------------------------------

  /** Current timecode in absolute frames. */
  private now(): number {
    if (this.tcSource === 'atem' && this.anchor) {
      return this.anchor.frames + ((performance.now() - this.anchor.ms) / 1000) * this.fr.real;
    }
    const d = new Date();
    const secs = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
    return secs * this.fr.real;
  }

  private handleTime(t: { hour: number; minute: number; second: number; frame: number; dropFrame?: boolean }): void {
    if (typeof t.dropFrame === 'boolean' && this.events.length === 0) this.df = t.dropFrame;
    this.anchor = { frames: tcToFrames(t.hour, t.minute, t.second, t.frame, this.fr.base, this.df), ms: performance.now() };
  }

  private configuredRate(ms: any): number {
    const s = ms?.transitionSettings ?? {};
    const style = ms?.transitionProperties?.style;
    const rate = style === 1 ? s.dip?.rate : style === 2 ? s.wipe?.rate : style === 3 ? s.DVE?.rate
      : style === 4 ? (s.stinger?.mixRate ?? s.stinger?.clipDuration) : s.mix?.rate;
    return typeof rate === 'number' && rate > 0 ? rate : this.fr.base;
  }

  private sourceInfo(input: number): { reel: string; name: string } {
    const inp = this.atem?.state?.inputs?.[input];
    const name = inp?.longName || inp?.shortName || `Input ${input}`;
    const override = this.reelOverrides[String(input)];
    let reel = override ?? (input === BLACK_INPUT ? 'BL' : (inp?.shortName || `IN${input}`));
    reel = reel.toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 8) || `IN${input}`;
    return { reel, name };
  }

  private pushEvent(input: number, frame: number, transition: 'C' | 'D', duration: number): void {
    const info = this.sourceInfo(input);
    this.events.push({ input, frame, transition, duration: Math.max(0, Math.min(999, Math.round(duration))), ...info } as any);
    void this.flush();
  }

  private handleState(state: any, paths: string[]): void {
    const prefix = `video.mixEffects.${this.me}`;
    if (!paths.some(p => p.startsWith(prefix))) return;
    const ms = state?.video?.mixEffects?.[this.me];
    if (!ms) return;
    const now = this.now();
    if (this.pending?.endedAt !== undefined && performance.now() - this.pending.endedAt > 1000) this.pending = null;

    const inTransition = !!ms.transitionPosition?.inTransition;
    const last = this.events[this.events.length - 1];
    if (last && ms.programInput !== last.input) {
      const p = this.pending as any;
      if (p && !p.consumed) {
        // Program changed at the end of a transition we watched start.
        const measured = now - p.startFrame;
        this.pushEvent(ms.programInput, p.startFrame, 'D', measured >= 2 ? measured : p.rate);
        this.pending = null;
      } else if (inTransition) {
        // Program changed at the start of a transition (some models/modes).
        const rate = this.configuredRate(ms);
        this.pushEvent(ms.programInput, now, 'D', rate);
        this.pending = { to: ms.programInput, startFrame: now, rate, consumed: true } as any;
      } else {
        this.pushEvent(ms.programInput, now, 'C', 0);
      }
    }

    if (inTransition && !this.pending) {
      this.pending = { to: ms.previewInput, startFrame: now, rate: this.configuredRate(ms) };
    } else if (!inTransition && this.pending && this.pending.endedAt === undefined) {
      this.pending.endedAt = performance.now();
    }
  }

  private tc(frames: number): string { return framesToTc(frames, this.fr.base, this.df); }
  private recTc(frame: number): string { return this.tc(this.recStart + (frame - this.events[0].frame)); }

  buildEdl(): string {
    const evs = this.events as (EdlEvent & { reel: string; name: string })[];
    const end = this.endFrame ?? this.now();
    const lines = [`TITLE: ${this.title}`, `FCM: ${this.df ? 'DROP FRAME' : 'NON-DROP FRAME'}`, ''];
    let n = 0;
    const num = () => String(n).padStart(3, '0');
    const reel = (r: string) => r.padEnd(8);
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      const next = i + 1 < evs.length ? evs[i + 1].frame : end;
      if (Math.round(next) <= Math.round(ev.frame)) continue;
      n++;
      const srcIn = this.tc(ev.frame), srcOut = this.tc(next);
      const recIn = this.recTc(ev.frame), recOut = this.recTc(next);
      if (ev.transition === 'D' && i > 0) {
        const prev = evs[i - 1];
        const dur = Math.max(1, Math.min(ev.duration, Math.round(next - ev.frame), 999));
        lines.push(`${num()}  ${reel(prev.reel)} V     C        ${srcIn} ${srcIn} ${recIn} ${recIn}`);
        lines.push(`${num()}  ${reel(ev.reel)} V     D    ${String(dur).padStart(3, '0')} ${srcIn} ${srcOut} ${recIn} ${recOut}`);
        lines.push(`* FROM CLIP NAME: ${prev.name}`, `* TO CLIP NAME: ${ev.name}`, '');
      } else {
        lines.push(`${num()}  ${reel(ev.reel)} V     C        ${srcIn} ${srcOut} ${recIn} ${recOut}`);
        lines.push(`* FROM CLIP NAME: ${ev.name}`, '');
      }
    }
    return lines.join('\n') + '\n';
  }

  buildMarkersEdl(): string {
    const lines = [`TITLE: ${this.title} Markers`, `FCM: ${this.df ? 'DROP FRAME' : 'NON-DROP FRAME'}`, ''];
    this.markers.forEach((m, i) => {
      const r = this.recTc(m.frame), r1 = this.recTc(m.frame + 1);
      const note = m.note.replace(/\|/g, '/').replace(/\s+/g, ' ');
      lines.push(`${String(i + 1).padStart(3, '0')}  001      V     C        ${r} ${r1} ${r} ${r1}  `);
      lines.push(` |C:ResolveColorBlue |M:${note} |D:1`, '');
    });
    return lines.join('\n') + '\n';
  }

  private flush(): Promise<void> {
    const edl = this.buildEdl();
    const markers = this.markers.length ? this.buildMarkersEdl() : null;
    const json = JSON.stringify({
      title: this.title, me: this.me + 1, frameRate: this.fr.label, dropFrame: this.df,
      timecodeSource: this.tcSource, startedAt: this.startedAt, stopped: this.endFrame !== null,
      events: (this.events as any[]).map(e => ({ ...e, timecode: this.tc(e.frame), record: this.recTc(e.frame) })),
      markers: this.markers.map(m => ({ ...m, record: this.recTc(m.frame) })),
    }, null, 2);
    const files = { ...this.files };
    this.writeChain = this.writeChain.then(async () => {
      await fs.writeFile(files.edl, edl, 'utf-8');
      await fs.writeFile(files.json, json, 'utf-8');
      if (markers) await fs.writeFile(files.markers, markers, 'utf-8');
    }).catch(err => { console.error('[atem-mcp] EDL write failed:', err); });
    return this.writeChain;
  }
}

export const edlLogger = new EdlLogger();
