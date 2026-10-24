// ---------------------------------------------------------------------------
// Tentacle Sync USB driver — talks to Tentacle Sync / Sync E / Track E timecode
// generators over USB, using the protocol reverse-engineered from Tentacle's
// own "Tentacle Setup" 3.00 app (TTUsb.framework):
//
//   VID 0x16D0, PID 0x081C (interface 0), 0x0D40 / 0x0D42 (interface 1)
//   Interrupt OUT endpoint 0x02, interrupt IN endpoint 0x81, 3 s timeout
//   36-byte packets: [cmd, 0xFF, len lo, len hi, payload (≤32 bytes, zero padded)]
//   Reply echoes cmd in byte 0; byte 1 is 0 on success; payload starts at byte 4.
//
// Tentacle Setup must be quit while this runs — both claim the same interface.
// The `usb` native module is loaded lazily so the server still starts without it.
// ---------------------------------------------------------------------------

export const TENTACLE_VID = 0x16d0;
/** App-mode product IDs, in the order tentacle_connect tries them. 0x0D41 (and likely 0x081D)
 *  are bootloaders used for firmware updates and are deliberately never opened. */
export const TENTACLE_PIDS = [0x081c, 0x0d40, 0x0d42];

export const CMD = {
  START_GENERATOR: 0x01,
  STOP_GENERATOR: 0x02,
  GET_MODE: 0x24,
  GET_FRAMERATE: 0x25,
  GET_TIMECODE: 0x27,
  SET_FRAMERATE: 0xa5,
  SET_FRAME_OFFSET: 0xa6,
  SET_TIMECODE: 0xa7,
} as const;

const PACKET_SIZE = 36;
const MAX_PAYLOAD = 32;
const EP_OUT = 0x02;
const EP_IN = 0x81;
const TIMEOUT_MS = 3000;

export interface Timecode { hour: number; minute: number; second: number; frame: number; }
export interface TentacleFrameRate { fps: number; ntsc: boolean; dropFrame: boolean; }

// ----------------------------- packet codec ---------------------------------

export function buildPacket(cmd: number, payload: ArrayLike<number> = []): Buffer {
  if (payload.length > MAX_PAYLOAD) throw new Error(`Tentacle payload too long (${payload.length} > ${MAX_PAYLOAD})`);
  const buf = Buffer.alloc(PACKET_SIZE);
  buf[0] = cmd;
  buf[1] = 0xff;
  buf.writeUInt16LE(payload.length, 2);
  for (let i = 0; i < payload.length; i++) buf[4 + i] = payload[i];
  return buf;
}

/** Validate a reply and return its payload (bytes 4..). */
export function parseReply(cmd: number, reply: Buffer): Buffer {
  if (reply.length < 4) throw new Error(`Tentacle reply too short (${reply.length} bytes)`);
  if (reply[1] !== 0) throw new Error(`Tentacle rejected command 0x${cmd.toString(16)} (status ${reply[1]})`);
  if (reply[0] !== cmd) throw new Error(`Tentacle replied to 0x${reply[0].toString(16)}, expected 0x${cmd.toString(16)}`);
  const len = Math.min(reply.readUInt16LE(2), reply.length - 4);
  return reply.subarray(4, 4 + len);
}

/** The device rejects anything outside 00:00:00:00–23:59:59:29, as Tentacle Setup does. */
export function timecodePayload(tc: Timecode): number[] {
  const { hour, minute, second, frame } = tc;
  if (![hour, minute, second, frame].every(Number.isInteger)
    || hour > 23 || minute > 59 || second > 59 || frame > 29 || Math.min(hour, minute, second, frame) < 0) {
    throw new Error(`Timecode out of range for Tentacle: ${formatTc(tc)}`);
  }
  return [hour, minute, second, frame];
}

export function framerateFromPayload(p: Buffer): TentacleFrameRate {
  return { fps: p[0], ntsc: p[1] !== 0, dropFrame: p[2] !== 0 };
}

export function formatTc(tc: Timecode): string {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(tc.hour)}:${p(tc.minute)}:${p(tc.second)}:${p(tc.frame)}`;
}

export function formatRate(r: TentacleFrameRate): string {
  const real = r.ntsc ? (r.fps / 1.001).toFixed(2) : String(r.fps);
  return `${real}${r.dropFrame ? ' DF' : ''}`;
}

// ------------------------------- device -------------------------------------

/** Minimal libusb surface we use (from the `usb` package). */
interface UsbDevice {
  deviceDescriptor: { idVendor: number; idProduct: number; iSerialNumber: number };
  busNumber: number;
  deviceAddress: number;
  open(): void;
  close(): void;
  interface(n: number): any;
  getStringDescriptor(index: number, cb: (err: any, value?: string) => void): void;
}

let usbModule: any | null = null;
async function loadUsb(): Promise<any> {
  if (usbModule) return usbModule;
  try {
    usbModule = await import('usb');
    return usbModule;
  } catch (err) {
    throw new Error(`The "usb" module is not available (${(err as Error).message}). Run npm install in the atem-mcp-server folder.`);
  }
}

export class TentacleDevice {
  private iface: any = null;
  private epOut: any = null;
  private epIn: any = null;
  private chain: Promise<unknown> = Promise.resolve();
  serial = '';

  constructor(private dev: UsbDevice) {}

  get pid(): number { return this.dev.deviceDescriptor.idProduct; }
  get id(): string { return this.serial || `usb-${this.dev.busNumber}-${this.dev.deviceAddress}`; }

  open(): void {
    // Same PID→interface map as tentacle_tools_pid_interface_mapping.
    const ifaceNum = this.pid >= 0x0d40 ? 1 : 0;
    this.dev.open();
    const iface = this.dev.interface(ifaceNum);
    try {
      if (iface.isKernelDriverActive?.()) iface.detachKernelDriver();
    } catch { /* not permitted on macOS without entitlements; claim may still work */ }
    try {
      iface.claim();
    } catch (err) {
      this.dev.close();
      throw new Error(`Cannot claim Tentacle USB interface (${(err as Error).message}). Quit Tentacle Setup and try again.`);
    }
    this.iface = iface;
    this.epOut = iface.endpoint(EP_OUT);
    this.epIn = iface.endpoint(EP_IN);
    if (!this.epOut || !this.epIn) {
      this.close();
      throw new Error('Tentacle USB endpoints 0x02/0x81 not found — unsupported model or firmware.');
    }
    this.epOut.timeout = TIMEOUT_MS;
    this.epIn.timeout = TIMEOUT_MS;
  }

  async readSerial(): Promise<void> {
    const idx = this.dev.deviceDescriptor.iSerialNumber;
    if (!idx) return;
    this.serial = await new Promise<string>(resolve =>
      this.dev.getStringDescriptor(idx, (err, v) => resolve(err ? '' : (v ?? ''))));
  }

  close(): void {
    try { this.iface?.release(true, () => { try { this.dev.close(); } catch { /* already closed */ } }); }
    catch { try { this.dev.close(); } catch { /* already closed */ } }
    this.iface = this.epOut = this.epIn = null;
  }

  /** Send one command and return the reply payload. Commands are serialized per device. */
  sendCmd(cmd: number, payload: ArrayLike<number> = []): Promise<Buffer> {
    const run = async () => {
      if (!this.epOut) throw new Error('Tentacle is not open.');
      const pkt = buildPacket(cmd, payload);
      await new Promise<void>((res, rej) => this.epOut.transfer(pkt, (e: any) => e ? rej(e) : res()));
      const reply = await new Promise<Buffer>((res, rej) =>
        this.epIn.transfer(PACKET_SIZE, (e: any, d?: Buffer) => e ? rej(e) : res(d ?? Buffer.alloc(0))));
      return parseReply(cmd, reply);
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  async getTimecode(): Promise<Timecode> {
    const p = await this.sendCmd(CMD.GET_TIMECODE);
    return { hour: p[0], minute: p[1], second: p[2], frame: p[3] };
  }

  async setTimecode(tc: Timecode): Promise<void> {
    await this.sendCmd(CMD.SET_TIMECODE, timecodePayload(tc));
  }

  async getFramerate(): Promise<TentacleFrameRate> {
    return framerateFromPayload(await this.sendCmd(CMD.GET_FRAMERATE));
  }

  async setFramerate(r: TentacleFrameRate): Promise<void> {
    await this.sendCmd(CMD.SET_FRAMERATE, [r.fps, r.ntsc ? 1 : 0, r.dropFrame ? 1 : 0]);
  }

  /** Raw mode byte (Tentacle Setup maps it to "ready", "power off", "sd card missing", …). */
  async getModeByte(): Promise<number> {
    return (await this.sendCmd(CMD.GET_MODE))[0];
  }
}

/** Open every connected Tentacle. Caller must close() each one. */
export async function openTentacles(): Promise<TentacleDevice[]> {
  const usb = await loadUsb();
  const list: UsbDevice[] = (usb.getDeviceList ?? usb.usb.getDeviceList)();
  const found = list.filter(d => d.deviceDescriptor.idVendor === TENTACLE_VID && TENTACLE_PIDS.includes(d.deviceDescriptor.idProduct));
  const opened: TentacleDevice[] = [];
  const errors: string[] = [];
  for (const d of found) {
    const t = new TentacleDevice(d);
    try {
      t.open();
      await t.readSerial();
      opened.push(t);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  if (!opened.length && errors.length) throw new Error(errors.join('; '));
  return opened;
}
