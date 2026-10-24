// Tentacle Sync USB protocol codec + jam timing, no hardware needed.
// Run: npm test   (builds, then node --test test/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  buildPacket, parseReply, timecodePayload, framerateFromPayload, formatRate, CMD, TENTACLE_PIDS,
} from '../dist/services/tentacle-usb.js';
import {
  tentacleRateFor, planJam, tentacleFramesAt, msForTentacleFrame, readAtemTime, readClockTime, readSourceTime,
} from '../dist/services/tentacle-jam.js';
import { tcToFrames } from '../dist/services/edl-logger.js';

const R2997 = { base: 30, real: 30000 / 1001, label: '29.97' };
const R25 = { base: 25, real: 25, label: '25' };
const R5994 = { base: 60, real: 60000 / 1001, label: '59.94' };

test('set-timecode packet matches tentacle_sendCmd layout', () => {
  const pkt = buildPacket(CMD.SET_TIMECODE, timecodePayload({ hour: 10, minute: 59, second: 30, frame: 29 }));
  assert.equal(pkt.length, 36);
  assert.deepEqual([...pkt.subarray(0, 8)], [0xa7, 0xff, 4, 0, 10, 59, 30, 29]);
  assert.ok(pkt.subarray(8).every(b => b === 0));
});

test('commands without payload send length 0', () => {
  assert.deepEqual([...buildPacket(CMD.GET_TIMECODE).subarray(0, 4)], [0x27, 0xff, 0, 0]);
});

test('timecode range matches the device check (≤23:59:59:29)', () => {
  assert.throws(() => timecodePayload({ hour: 24, minute: 0, second: 0, frame: 0 }));
  assert.throws(() => timecodePayload({ hour: 0, minute: 60, second: 0, frame: 0 }));
  assert.throws(() => timecodePayload({ hour: 0, minute: 0, second: 0, frame: 30 }));
  assert.deepEqual(timecodePayload({ hour: 23, minute: 59, second: 59, frame: 29 }), [23, 59, 59, 29]);
});

test('reply parsing checks status and echoed command', () => {
  const ok = Buffer.alloc(36); ok[0] = 0x27; ok[1] = 0; ok.writeUInt16LE(4, 2); ok.set([1, 2, 3, 4], 4);
  assert.deepEqual([...parseReply(0x27, ok)], [1, 2, 3, 4]);
  const bad = Buffer.from(ok); bad[1] = 1;
  assert.throws(() => parseReply(0x27, bad), /rejected/);
  assert.throws(() => parseReply(0x25, ok), /expected/);
});

test('frame rate payload: fps, ntsc (÷1.001), drop frame', () => {
  assert.equal(formatRate(framerateFromPayload(Buffer.from([30, 1, 1]))), '29.97 DF');
  assert.equal(formatRate(framerateFromPayload(Buffer.from([24, 1, 0]))), '23.98');
  assert.equal(formatRate(framerateFromPayload(Buffer.from([25, 0, 0]))), '25');
});

test('bootloader PIDs are never opened', () => {
  assert.ok(!TENTACLE_PIDS.includes(0x0d41));
  assert.ok(!TENTACLE_PIDS.includes(0x081d));
});

test('switcher rates map to Tentacle rates', () => {
  assert.deepEqual(tentacleRateFor(R2997, true), { rate: { fps: 30, ntsc: true, dropFrame: true }, divisor: 1, base: 30 });
  assert.deepEqual(tentacleRateFor(R25, false), { rate: { fps: 25, ntsc: false, dropFrame: false }, divisor: 1, base: 25 });
  assert.deepEqual(tentacleRateFor(R5994, true), { rate: { fps: 30, ntsc: true, dropFrame: true }, divisor: 2, base: 30 });
  assert.equal(tentacleRateFor({ base: 24, real: 24000 / 1001, label: '23.976' }, false).rate.dropFrame, false);
});

test('jam lands on a frame boundary with latency compensation', () => {
  const plan = tentacleRateFor(R25, false);
  const anchor = { frames: tcToFrames(14, 0, 0, 0, 25, false), ms: 1000 };
  const now = 1000 + 10;                 // 10 ms into frame 14:00:00:00
  const j = planJam(anchor, now, R25, plan, 3, 0);
  // Next boundary is 40 ms after the anchor, but lead time needs ≥20 ms → 14:00:00:01 at t=1040, sent at 1037.
  assert.deepEqual(j.tc, { hour: 14, minute: 0, second: 0, frame: 1 });
  assert.equal(j.sendAtMs, 1037);
  assert.equal(Math.round(tentacleFramesAt(anchor, j.sendAtMs + 3, R25, 1)), j.frame);
});

test('offset frames shift the jammed timecode', () => {
  const plan = tentacleRateFor(R25, false);
  const anchor = { frames: tcToFrames(14, 0, 0, 0, 25, false), ms: 0 };
  assert.deepEqual(planJam(anchor, 0, R25, plan, 0, -2).tc, { hour: 13, minute: 59, second: 59, frame: 24 });
});

test('59.94 switcher jams at 29.97 DF on even switcher frames', () => {
  const plan = tentacleRateFor(R5994, true);
  const anchor = { frames: tcToFrames(1, 9, 59, 58, 60, true), ms: 0 };
  const j = planJam(anchor, 0, R5994, plan, 0, 0, 0);
  // Switcher 01:09:59:58 is Tentacle 01:09:59:29; the next frame crosses into minute 10 (no drop at x0 minutes).
  assert.deepEqual(j.tc, { hour: 1, minute: 10, second: 0, frame: 0 });
  assert.ok(Math.abs(msForTentacleFrame(anchor, j.frame, R5994, 2) - 2 * 1001 / 60) < 1e-6);
});

test('readAtemTime anchors the switcher Time reply', async () => {
  const atem = new EventEmitter();
  atem.state = { settings: { videoMode: undefined } };
  atem.requestTime = async () => { setTimeout(() => atem.emit('updatedTime', { hour: 1, minute: 0, second: 0, frame: 0, dropFrame: true }), 5); };
  const t = await readAtemTime(atem);
  assert.equal(t.dropFrame, true);
  assert.equal(t.anchor.frames, tcToFrames(1, 0, 0, 0, 30, true));
  assert.equal(atem.listenerCount('updatedTime'), 0);
});

test('readAtemTime fails clearly when the switcher stays silent', async () => {
  const atem = new EventEmitter();
  atem.state = {};
  atem.requestTime = async () => {};
  await assert.rejects(readAtemTime(atem, 50), /did not report its timecode/);
});

test('clock source counts time of day like the EDL logger', () => {
  const atem = new EventEmitter();
  atem.state = { settings: { videoMode: undefined } };          // unknown mode → 29.97 DF
  const d = new Date();
  const c = readClockTime(atem);
  const secs = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
  assert.equal(c.dropFrame, true);
  assert.ok(Math.abs(c.anchor.frames - secs * c.fr.real) < c.fr.real); // within a second of the same count
});

test('switcher source needs a switcher; clock source does not', async () => {
  await assert.rejects(readSourceTime(null, 'atem'), /Not connected/);
  assert.ok((await readSourceTime(null, 'clock')).anchor.frames >= 0);
});
