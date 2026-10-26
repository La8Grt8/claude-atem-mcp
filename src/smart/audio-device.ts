// ---------------------------------------------------------------------------
// USB mixer capture — reads every channel of a macOS audio device through
// ffmpeg (avfoundation → raw float32 on stdout) and turns it into per-channel
// RMS levels in dBFS. No native Node modules needed; ffmpeg must be on PATH
// (or set FFMPEG_PATH).
//
// read() returns, for each channel, the loudest 10 ms RMS block since the last
// read, so a tick never misses a syllable that happened between ticks.
// ---------------------------------------------------------------------------

import { spawn, ChildProcessWithoutNullStreams, execFile } from 'child_process';
import { SILENCE_DB } from './types.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const BLOCK_MS = 10;
const STALL_MS = 1500;

const LAYOUT_CHANNELS: Record<string, number> = {
  mono: 1, stereo: 2, '2.1': 3, '3.0': 3, '3.0(back)': 3, quad: 4, '4.0': 4, 'quad(side)': 4,
  '5.0': 5, '5.0(side)': 5, '5.1': 6, '5.1(side)': 6, '6.0': 6, '6.1': 7, '7.0': 7, '7.1': 8,
  octagonal: 8, hexadecagonal: 16,
};

export interface AudioDevice { index: number; name: string; }

/** List avfoundation audio input devices. */
export function listAudioDevices(): Promise<AudioDevice[]> {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
      { timeout: 10000 }, (err, _stdout, stderr) => {
        // ffmpeg always "fails" here (no input opened); only a missing binary is a real error
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(`ffmpeg not found (${FFMPEG}). Install it (brew install ffmpeg) or set FFMPEG_PATH.`));
          return;
        }
        const out: AudioDevice[] = [];
        let inAudio = false;
        for (const line of String(stderr).split('\n')) {
          if (/AVFoundation audio devices/.test(line)) { inAudio = true; continue; }
          if (/AVFoundation video devices/.test(line)) { inAudio = false; continue; }
          const m = inAudio && line.match(/\]\s\[(\d+)\]\s(.+)$/);
          if (m) out.push({ index: Number(m[1]), name: m[2].trim() });
        }
        resolve(out);
      });
  });
}

export interface DeviceMeterStatus {
  running: boolean;
  device: string | null;
  channels: number;
  sampleRate: number;
  lastDataAgoMs: number | null;
  error: string | null;
}

export class DeviceMeter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private device: string | null = null;
  private channels = 0;
  private sampleRate = 48000;
  private carry = Buffer.alloc(0);
  private blockFrames = 480;
  private acc: Float64Array = new Float64Array(0);
  private accFrames = 0;
  private maxSinceRead: Float64Array = new Float64Array(0);
  private lastDataAt = 0;
  private error: string | null = null;
  private stderrTail = '';

  /**
   * Start capturing. `device` is an avfoundation audio index or exact name.
   * `channels` overrides the count when ffmpeg reports an unknown layout.
   */
  start(device: string, opts: { sampleRate?: number; channels?: number } = {}): Promise<number> {
    this.stop();
    this.device = device;
    this.sampleRate = opts.sampleRate ?? 48000;
    this.blockFrames = Math.round(this.sampleRate * BLOCK_MS / 1000);
    this.error = null;
    this.channels = 0;
    this.stderrTail = '';

    const args = ['-hide_banner', '-nostats', '-loglevel', 'info', '-f', 'avfoundation',
      '-sample_rate', String(this.sampleRate), '-i', `:${device}`,
      '-vn', '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'];
    const proc = spawn(FFMPEG, args);
    this.proc = proc;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (msg: string) => {
        this.error = msg;
        if (!settled) { settled = true; reject(new Error(msg)); }
      };
      const timer = setTimeout(() => fail(`No audio from "${device}" after 5 s.${this.hint()}`), 5000);

      proc.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        fail(e.code === 'ENOENT' ? `ffmpeg not found (${FFMPEG}). Install it or set FFMPEG_PATH.` : e.message);
      });
      proc.stderr.on('data', (d: Buffer) => {
        this.stderrTail = (this.stderrTail + d.toString()).slice(-4000);
        if (this.channels) return;
        const m = this.stderrTail.match(/Audio: pcm_\w+.*?, (\d+) Hz, ([^,]+),/);
        if (!m) return;
        const layout = m[2].trim();
        const n = opts.channels ?? (layout.match(/^(\d+) channels/) ? Number(layout.match(/^(\d+)/)![1]) : LAYOUT_CHANNELS[layout]);
        if (!n) { clearTimeout(timer); fail(`Unknown channel layout "${layout}": pass channels explicitly.`); proc.kill(); return; }
        this.setChannels(n);
      });
      proc.stdout.on('data', (d: Buffer) => {
        if (!this.channels) return;
        this.consume(d);
        if (!settled) { settled = true; clearTimeout(timer); resolve(this.channels); }
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (this.proc === proc) this.proc = null;
        if (code !== 0 && code !== null) fail(`ffmpeg exited (${code}).${this.hint()}`);
      });
    });
  }

  stop(): void {
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      p.kill('SIGTERM');
    }
  }

  /** dBFS per channel (index 0 = channel 1): loudest 10 ms block since the last read. */
  read(): number[] {
    const out: number[] = [];
    for (let c = 0; c < this.channels; c++) {
      const ms = this.maxSinceRead[c];
      out.push(ms > 0 ? Math.max(SILENCE_DB, 10 * Math.log10(ms)) : SILENCE_DB);
      this.maxSinceRead[c] = 0;
    }
    return out;
  }

  stalled(): boolean {
    return this.proc !== null && this.lastDataAt > 0 && Date.now() - this.lastDataAt > STALL_MS;
  }

  status(): DeviceMeterStatus {
    return {
      running: this.proc !== null,
      device: this.device,
      channels: this.channels,
      sampleRate: this.sampleRate,
      lastDataAgoMs: this.lastDataAt ? Date.now() - this.lastDataAt : null,
      error: this.error,
    };
  }

  // -------------------------------------------------------------------------

  private setChannels(n: number): void {
    this.channels = n;
    this.acc = new Float64Array(n);
    this.maxSinceRead = new Float64Array(n);
    this.accFrames = 0;
    this.carry = Buffer.alloc(0);
  }

  private consume(chunk: Buffer): void {
    this.lastDataAt = Date.now();
    const buf = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const frameBytes = 4 * this.channels;
    const frames = Math.floor(buf.length / frameBytes);
    const n = this.channels;
    for (let f = 0; f < frames; f++) {
      const off = f * frameBytes;
      for (let c = 0; c < n; c++) {
        const v = buf.readFloatLE(off + 4 * c);
        this.acc[c] += v * v;
      }
      if (++this.accFrames >= this.blockFrames) {
        for (let c = 0; c < n; c++) {
          const ms = this.acc[c] / this.accFrames;     // mean square → dB = 10·log10
          if (ms > this.maxSinceRead[c]) this.maxSinceRead[c] = ms;
          this.acc[c] = 0;
        }
        this.accFrames = 0;
      }
    }
    this.carry = Buffer.from(buf.subarray(frames * frameBytes));
  }

  private hint(): string {
    const last = this.stderrTail.trim().split('\n').slice(-2).join(' ').trim();
    const perm = /not authorized|permission|denied/i.test(this.stderrTail)
      ? ' macOS may be blocking the microphone: allow it for the app running this server (System Settings → Privacy & Security → Microphone).'
      : '';
    return (last ? ` ffmpeg: ${last}` : '') + perm;
  }
}
