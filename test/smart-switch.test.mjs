// Smart switch engine + calibration, driven by synthetic mic levels.
// Run: npm test   (builds, then node --test test/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwitchEngine } from '../dist/smart/engine.js';
import { measureNoise, measureSpeaker, checkTogether } from '../dist/smart/calibration.js';
import { newProfile, dbSum } from '../dist/smart/types.js';

const TICK = 50;
const NOISE = -62;
const BLEED = -12;           // every voice reaches every other mic 12 dB down

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function makeProfile({ learned = false } = {}) {
  const p = newProfile('Test');
  p.mics = ['Rob', 'Ana', 'Ben'].map((name, i) => ({
    id: `m${i + 1}`, name, source: { kind: 'device', channel: i + 1 }, enabled: true, manualThresholdDb: null,
  }));
  p.cameras = [
    { input: 1, name: 'Wide', mics: ['m1', 'm2', 'm3'] },
    { input: 2, name: 'Rob', mics: ['m1'] },
    { input: 3, name: 'Ana', mics: ['m2'] },
    { input: 4, name: 'Ben', mics: ['m3'] },
  ];
  p.rules.adaptive = false;
  p.rules.varietyMs = 0;
  if (learned) {
    for (const s of ['m1', 'm2', 'm3']) {
      p.learned.noiseFloorDb[s] = NOISE;
      p.learned.bleedDb[s] = {};
      for (const d of ['m1', 'm2', 'm3']) if (d !== s) p.learned.bleedDb[s][d] = BLEED;
    }
  }
  return p;
}

/**
 * Synthetic room: `script` is a list of [durationMs, {micId: voiceDb}] segments.
 * Speech is bursty (syllables with short dips); every voice also reaches the
 * other mics BLEED dB down; each mic has its own noise.
 */
function room(script, seed = 1) {
  const r = rng(seed);
  const frames = [];
  let t = 0;
  for (const [dur, voices] of script) {
    for (let e = 0; e < dur; e += TICK, t += TICK) {
      const live = {};
      for (const [id, db] of Object.entries(voices)) {
        const syllable = (Math.floor(t / 250) + id.length) % 6 !== 0;   // a ~250 ms dip every 1.5 s
        if (syllable) live[id] = db - 6 * r();
      }
      const levels = {};
      for (const d of ['m1', 'm2', 'm3']) {
        const parts = [NOISE + 2 * r()];
        for (const [s, v] of Object.entries(live)) parts.push(s === d ? v : v + BLEED);
        levels[d] = dbSum(parts);
      }
      frames.push({ t, levels });
    }
  }
  return frames;
}

/** Drive an engine like the controller does, with a simulated program bus. */
function run(profile, frames, { program = 1, onTick } = {}) {
  const eng = new SwitchEngine(profile);
  const cuts = [];
  for (const f of frames) {
    onTick?.(f.t, eng, (p) => { program = p; });
    eng.notifyProgram(program, f.t);
    const d = eng.update(f.levels, f.t);
    if (d.cutTo !== null) {
      eng.commandSent(d.cutTo, f.t);
      program = d.cutTo;
      cuts.push({ t: f.t, input: d.cutTo, reason: d.reason });
    }
  }
  return { cuts, program, eng };
}

test('cuts to the person talking, after the confirm delay', () => {
  const { cuts } = run(makeProfile({ learned: true }), room([[1000, {}], [4000, { m2: -18 }]]));
  assert.equal(cuts[0].input, 3);
  assert.match(cuts[0].reason, /Ana talking/);
  const delay = cuts[0].t - 1000;
  assert.ok(delay >= 300 + 400 && delay < 1500, `cut after ${delay} ms`);
});

test('learned bleed: a loud speaker does not make the neighbour mics count as voice', () => {
  const { cuts, eng } = run(makeProfile({ learned: true }), room([[500, {}], [6000, { m1: -10 }]]));
  assert.deepEqual(cuts.map(c => c.input), [2]);
  const st = Object.fromEntries(eng.status().map(s => [s.id, s]));
  assert.equal(st.m2.ownVoice, false);
  assert.equal(st.m3.ownVoice, false);
});

test('adaptive learning picks up the bleed when one person talks alone', () => {
  const p = makeProfile();
  p.rules.adaptive = true;
  run(p, room([[2000, {}], [20000, { m1: -12 }]]));
  const learned = p.learned.bleedDb.m1;
  assert.ok(learned && learned.m2 !== undefined, 'learned Rob→Ana');
  assert.ok(Math.abs(learned.m2 - BLEED) < 4, `Rob→Ana ≈ ${learned.m2}`);
});

test('two people talking long enough → camera that shows both (the wide)', () => {
  const { cuts } = run(makeProfile({ learned: true }), room([[500, {}], [3000, { m1: -16 }], [6000, { m1: -16, m2: -16 }]]));
  assert.equal(cuts[0].input, 2);
  const wide = cuts.find(c => c.input === 1);
  assert.ok(wide, `cuts: ${JSON.stringify(cuts)}`);
  assert.match(wide.reason, /2 talking/);
});

test('short overlap does not open the wide shot', () => {
  const { cuts } = run(makeProfile({ learned: true }), room([[500, {}], [4000, { m1: -16 }], [1200, { m1: -16, m2: -16 }], [3000, { m1: -16 }]]));
  assert.ok(!cuts.some(c => c.input === 1), JSON.stringify(cuts));
});

test('manual cut pauses the engine for manualHoldMs', () => {
  const p = makeProfile({ learned: true });
  p.rules.manualHoldMs = 5000;
  const frames = room([[500, {}], [3000, { m1: -16 }], [8000, { m2: -16 }]]);
  // the operator cuts to Ben (4) by hand at t=3600, just as Ana starts talking
  const { cuts } = run(p, frames, { onTick: (t, _e, setProgram) => { if (t === 3600) setProgram(4); } });
  const ana = cuts.find(c => c.input === 3);
  assert.ok(ana, JSON.stringify(cuts));
  assert.ok(ana.t >= 3600 + 5000, `cut to Ana at ${ana.t}, before the pause ended`);
});

test('does not cut over a non-camera source when respectOtherSources is on', () => {
  const { cuts } = run(makeProfile({ learned: true }), room([[500, {}], [5000, { m3: -16 }]]), { program: 3010 });
  assert.equal(cuts.length, 0);
});

test('silence → wide shot after silenceMs when configured', () => {
  const p = makeProfile({ learned: true });
  p.rules.silenceAction = 'wide';
  p.rules.silenceMs = 3000;
  const { cuts } = run(p, room([[500, {}], [3000, { m2: -16 }], [6000, {}]]));
  assert.deepEqual(cuts.map(c => c.input), [3, 1]);
  assert.match(cuts[1].reason, /Silence/);
});

test('minimum shot length is respected', () => {
  const p = makeProfile({ learned: true });
  p.rules.minShotMs = 4000;
  const { cuts } = run(p, room([[500, {}], [1500, { m1: -16 }], [1500, { m2: -16 }], [4000, { m3: -16 }]]));
  for (let i = 1; i < cuts.length; i++) assert.ok(cuts[i].t - cuts[i - 1].t >= 4000, JSON.stringify(cuts));
});

test('variety: a long monologue gets a brief cutaway to the wide, then back', () => {
  const p = makeProfile({ learned: true });
  p.rules.varietyMs = 10000;
  p.rules.varietyHoldMs = 2000;
  p.rules.releaseMs = 1300;
  const { cuts } = run(p, room([[500, {}], [25000, { m1: -16 }]]));
  const seq = cuts.map(c => c.input);
  assert.deepEqual(seq.slice(0, 3), [2, 1, 2], JSON.stringify(cuts));
  assert.match(cuts[1].reason, /Variety/);
});

test('calibration: noise floors and bleed row are measured', () => {
  const names = { m1: 'Rob', m2: 'Ana', m3: 'Ben' };
  const quiet = room([[6000, {}]]).map(f => f.levels);
  const n = measureNoise(quiet, ['m1', 'm2', 'm3'], names);
  for (const id of ['m1', 'm2', 'm3']) assert.ok(Math.abs(n.floors[id] - NOISE) < 2, `${id} floor ${n.floors[id]}`);

  const alone = room([[8000, { m2: -14 }]]).map(f => f.levels);
  const s = measureSpeaker(alone, 'm2', ['m1', 'm2', 'm3'], n.floors, names);
  assert.ok(s.ok);
  assert.ok(Math.abs(s.bleedRow.m1 - BLEED) < 2 && Math.abs(s.bleedRow.m3 - BLEED) < 2, JSON.stringify(s.bleedRow));
  assert.equal(s.warnings.length, 0);

  const wrong = measureSpeaker(alone, 'm1', ['m1', 'm2', 'm3'], n.floors, names);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.suggestedMic, 'm2');
});

test('calibration: together check detects everyone with a sane bleed matrix', () => {
  const p = makeProfile({ learned: true });
  const r = checkTogether(p, room([[8000, { m1: -16, m2: -16, m3: -16 }]]), ['m1', 'm2', 'm3']);
  assert.deepEqual(r.hidden, []);
  for (const v of Object.values(r.detectedShare)) assert.ok(v > 0.5, JSON.stringify(r.detectedShare));
});

test('calibration: together check loosens an over-estimated bleed', () => {
  const p = makeProfile({ learned: true });
  p.learned.bleedDb.m1.m2 = -1;          // wildly wrong: says Rob is almost as loud as Ana in Ana's mic
  p.learned.bleedDb.m3.m2 = -1;
  const r = checkTogether(p, room([[8000, { m1: -14, m2: -18, m3: -14 }]]), ['m1', 'm2', 'm3']);
  assert.ok(r.relaxed.includes('Ana'), JSON.stringify(r));
  assert.ok(p.learned.bleedDb.m1.m2 < -1);
});

test('group rule: several talking → wide by default, or the tightest shared camera when groupShot = tightest', () => {
  const script = [[500, {}], [3000, { m1: -16 }], [6000, { m1: -16, m2: -16 }]];
  const withTwoShot = () => {
    const p = makeProfile({ learned: true });
    p.cameras.push({ input: 5, name: 'Rob + Ana', mics: ['m1', 'm2'] });
    return p;
  };
  const wide = run(withTwoShot(), room(script));
  assert.equal(wide.program, 1, JSON.stringify(wide.cuts));

  const p = withTwoShot();
  p.rules.groupShot = 'tightest';
  const tight = run(p, room(script));
  assert.equal(tight.program, 5, JSON.stringify(tight.cuts));

  const fast = withTwoShot();
  fast.rules.groupConfirmMs = 0;
  const quick = run(fast, room(script));
  const t = quick.cuts.find(c => c.input === 1).t;
  assert.ok(t - 3500 < 1500, `wide after ${t - 3500} ms of overlap`);
});
