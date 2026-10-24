import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { smartSwitch } from '../smart/controller.js';
import { listAudioDevices } from '../smart/audio-device.js';
import { checkTogether, measureNoise, measureSpeaker } from '../smart/calibration.js';
import { Mic, Profile, Rules, SpeedKey, applySpeed, profileProblems } from '../smart/types.js';
import { getAtem, isAtemConnected } from '../services/atem-connection.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (o: unknown) => text(JSON.stringify(o, null, 2));

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Resolve a person/mic by name (case-insensitive) or id. */
function micByName(p: Profile, name: string): Mic {
  const n = name.trim().toLowerCase();
  const m = p.mics.find(x => x.name.toLowerCase() === n || x.id === name);
  if (!m) throw new Error(`No mic named "${name}". Mics: ${p.mics.map(x => x.name).join(', ') || '(none)'}`);
  return m;
}

function names(p: Profile): Record<string, string> {
  return Object.fromEntries(p.mics.map(m => [m.id, m.name]));
}

async function startMeters(): Promise<void> {
  const wasRunning = smartSwitch.metersRunning();
  await smartSwitch.ensureMeters();
  if (!wasRunning) await sleep(600);   // let the floors and envelopes settle
}

function fail(e: unknown) {
  return text(`Error: ${e instanceof Error ? e.message : String(e)}`);
}

const SPEEDS = ['very_fast', 'fast', 'normal', 'calm', 'custom'] as const;

export function registerSmartSwitchTools(server: McpServer): void {

  server.registerTool(
    'atem_smart_audio_devices',
    {
      title: 'List Audio Devices (Smart Switch)',
      description: `List macOS audio input devices (USB mixers, interfaces) that the smart switch can read mic channels from, via ffmpeg. Also shows which device is configured and whether it is being read.
Mics can instead come from the ATEM's own Fairlight inputs — then no device is needed.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return json({ devices: await listAudioDevices(), current: smartSwitch.deviceStatus() });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'atem_smart_setup',
    {
      title: 'Set Up Smart Switch',
      description: `Configure the active smart-switch profile: who is on which mic, which ATEM inputs are cameras and who is visible on each, and the cutting rules. Only the fields you pass change.

The smart switch cuts to whoever is talking, but unlike the classic auto-switch it knows how much each person's voice bleeds into the other mics, so a loud neighbour doesn't steal the shot.

Args:
  - audio_device: avfoundation audio device index or name for USB-mixer mics (see atem_smart_audio_devices)
  - mics: full list of people/mics. Each: { name, atem_input } for an ATEM Fairlight input, or { name, channel } for a USB mixer channel (1-based). Optional enabled, threshold_db (manual voice threshold in dBFS; null = automatic). Replaces the list; learned values are kept for mics whose name is unchanged.
  - cameras: full list of camera inputs. Each: { input, name?, people: [mic names visible in the shot] }. Put everyone on the wide shot.
  - speed: very_fast | fast | normal | calm — sets min shot, confirm delay, voice start and voice end together
  - rules: any of min_shot_ms, switch_delay_ms, attack_ms, release_ms, group_count, group_confirm_ms, silence_action (stay|wide|camera), silence_camera, silence_ms, variety_ms (0 = off), variety_hold_ms, manual_hold_ms, respect_other_sources, transition (cut|auto), me, auto_margin_db, bleed_margin_db, weak_mic_reject_db (null = off), adaptive. Setting a timing rule switches speed to "custom".

Example: mics [{name:"Rob",channel:1},{name:"Ana",channel:2}], cameras [{input:1,name:"Wide",people:["Rob","Ana"]},{input:2,people:["Rob"]},{input:3,people:["Ana"]}]`,
      inputSchema: {
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
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ audio_device, mics, cameras, speed, rules }) => {
      try {
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
        }

        if (cameras) {
          p.cameras = cameras.map(c => ({
            input: c.input,
            name: c.name ?? (isAtemConnected() ? (getAtem().state?.inputs?.[c.input]?.shortName ?? `Cam ${c.input}`) : `Cam ${c.input}`),
            mics: c.people.map(n => micByName(p, n).id),
          }));
        }

        if (speed) applySpeed(p, speed as SpeedKey);
        if (rules) {
          const map: Record<string, keyof Rules> = {
            min_shot_ms: 'minShotMs', switch_delay_ms: 'switchDelayMs', attack_ms: 'attackMs', release_ms: 'releaseMs',
            group_count: 'groupCount', group_confirm_ms: 'groupConfirmMs', silence_action: 'silenceAction',
            silence_camera: 'silenceCamera', silence_ms: 'silenceMs', variety_ms: 'varietyMs', variety_hold_ms: 'varietyHoldMs',
            manual_hold_ms: 'manualHoldMs', respect_other_sources: 'respectOtherSources', transition: 'transition', me: 'me',
            auto_margin_db: 'autoMarginDb', bleed_margin_db: 'bleedMarginDb', weak_mic_reject_db: 'weakMicRejectDb', adaptive: 'adaptive',
          };
          for (const [k, v] of Object.entries(rules)) {
            if (v === undefined) continue;
            (p.rules as unknown as Record<string, unknown>)[map[k]] = v;
            if (['min_shot_ms', 'switch_delay_ms', 'attack_ms', 'release_ms'].includes(k)) p.speed = 'custom';
          }
        }

        smartSwitch.profileChanged();
        await smartSwitch.save();
        const problems = profileProblems(p);
        return json({
          saved: smartSwitch.configPath(),
          profile: p.name,
          audioDevice: smartSwitch.config.audioDevice,
          mics: p.mics.map(m => ({ name: m.name, source: m.source, enabled: m.enabled, thresholdDb: m.manualThresholdDb })),
          cameras: p.cameras.map(c => ({ input: c.input, name: c.name, people: c.mics.map(id => names(p)[id]) })),
          speed: p.speed,
          rules: p.rules,
          problems,
          next: problems.length ? 'Fix the problems above.' : 'Calibrate with atem_smart_calibrate (noise → each speaker → together), or start with atem_smart_switch_on simulate:true.',
        });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'atem_smart_profile',
    {
      title: 'Smart Switch Profiles',
      description: `Manage smart-switch profiles (one per show setup). Actions: list, get (full active profile incl. learned bleed), use (make active), create (empty, or copy_from another), delete.`,
      inputSchema: {
        action: z.enum(['list', 'get', 'use', 'create', 'delete']),
        name: z.string().optional().describe('Profile name (use/create/delete)'),
        copy_from: z.string().optional().describe('Create as a copy of this profile'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ action, name, copy_from }) => {
      try {
        const cfg = smartSwitch.config;
        if (action === 'list') {
          return json({ active: cfg.activeProfile, profiles: cfg.profiles.map(p => ({ name: p.name, mics: p.mics.length, cameras: p.cameras.length, speed: p.speed })) });
        }
        if (action === 'get') return json(smartSwitch.profile());
        if (!name) return text('Error: name is required for this action.');
        if (action === 'use') {
          if (smartSwitch.isSwitching()) return text('Stop the smart switch before changing profile.');
          smartSwitch.useProfile(name);
        } else if (action === 'create') {
          smartSwitch.createProfile(name, copy_from);
        } else {
          smartSwitch.deleteProfile(name);
        }
        await smartSwitch.save();
        return text(`Done. Active profile: ${cfg.activeProfile}. Profiles: ${cfg.profiles.map(p => p.name).join(', ')}.`);
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'atem_smart_calibrate',
    {
      title: 'Calibrate Smart Switch',
      description: `Teach the smart switch each mic's background noise and how much each person's voice bleeds into the other mics. Run the steps in order; each one records for a few seconds (the call returns when done) and saves the result to the profile.

Steps:
  1. "noise": NOBODY talks for \`seconds\` (default 8) — measures each mic's noise floor.
  2. "speaker": ONLY \`mic\` talks for \`seconds\` (default 10), normal voice; everyone else silent. Repeat for every person. put_on_air: true cuts to that person's camera while learning (not while the smart switch is running).
  3. "together": the people in \`people\` (default: everyone) talk AT THE SAME TIME for \`seconds\` (default 10). Checks nobody gets hidden and loosens the bleed filter if someone does.
  4. "summary": shows the learned bleed matrix and what's still missing.

Tell the user exactly who should talk (or stay quiet) BEFORE calling each step.`,
      inputSchema: {
        step: z.enum(['noise', 'speaker', 'together', 'summary']),
        mic: z.string().optional().describe('Person/mic name for the speaker step'),
        people: z.array(z.string()).optional().describe('Who talks at once in the together step (default everyone)'),
        seconds: z.number().min(3).max(60).optional(),
        put_on_air: z.boolean().default(false).describe('Speaker step: cut to their camera while learning'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ step, mic, people, seconds, put_on_air }) => {
      try {
        const p = smartSwitch.profile();
        const enabled = p.mics.filter(m => m.enabled);
        const ids = enabled.map(m => m.id);
        const nm = names(p);
        if (step !== 'summary' && enabled.length === 0) return text('No mics are enabled. Set them up with atem_smart_setup first.');

        if (step === 'summary') {
          const matrix: Record<string, Record<string, number | null>> = {};
          for (const s of enabled) {
            matrix[s.name] = {};
            for (const d of enabled) if (d.id !== s.id) {
              const v = p.learned.bleedDb[s.id]?.[d.id];
              matrix[s.name][d.name] = v === undefined ? null : Math.round(v * 10) / 10;
            }
          }
          const missingNoise = enabled.filter(m => p.learned.noiseFloorDb[m.id] === undefined).map(m => m.name);
          const missingSpeaker = enabled.filter(m => !p.learned.bleedDb[m.id] || Object.keys(p.learned.bleedDb[m.id]).length < enabled.length - 1).map(m => m.name);
          return json({
            profile: p.name,
            noiseFloorDb: Object.fromEntries(enabled.map(m => [m.name, p.learned.noiseFloorDb[m.id] ?? null])),
            speechDb: Object.fromEntries(enabled.map(m => [m.name, p.learned.speechDb[m.id] ?? null])),
            bleedDb: matrix,
            note: 'bleedDb[A][B] = how loud A sounds in B\'s mic relative to A\'s own mic. More negative = better separated; above −6 dB means the two mics hear almost the same.',
            missing: { noise: missingNoise, speaker: missingSpeaker },
            problems: profileProblems(p),
          });
        }

        await startMeters();

        if (step === 'noise') {
          const frames = await smartSwitch.record((seconds ?? 8) * 1000);
          const r = measureNoise(frames.map(f => f.levels), ids, nm);
          Object.assign(p.learned.noiseFloorDb, r.floors);
          smartSwitch.profileChanged();
          await smartSwitch.save();
          return json({
            step: 'noise', frames: frames.length,
            noiseFloorDb: Object.fromEntries(Object.entries(r.floors).map(([id, v]) => [nm[id], Math.round(v * 10) / 10])),
            warnings: r.warnings,
            next: `Now only ${enabled[0].name} talks: atem_smart_calibrate step "speaker" mic "${enabled[0].name}".`,
          });
        }

        if (step === 'speaker') {
          if (!mic) return text('Error: mic is required for the speaker step.');
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
          const idx = enabled.findIndex(x => x.id === m.id);
          const nextMic = enabled[idx + 1];
          return json({
            step: 'speaker', mic: m.name, ok: r.ok, voicedTicks: r.voicedFrames,
            speechDb: r.speechDb === null ? null : Math.round(r.speechDb * 10) / 10,
            bleedIntoOthersDb: Object.fromEntries(Object.entries(r.bleedRow).map(([id, v]) => [nm[id], Math.round(v * 10) / 10])),
            suggestedMic: r.suggestedMic ? nm[r.suggestedMic] : null,
            warnings: r.warnings,
            next: !r.ok ? 'Redo this step (check the mic is on and mapped to the right channel).'
              : nextMic ? `Next: only ${nextMic.name} talks — step "speaker" mic "${nextMic.name}".`
              : 'Next: everyone talks at once — step "together".',
          });
        }

        // together
        const who = (people && people.length ? people.map(n => micByName(p, n)) : enabled).map(m => m.id);
        if (who.length < 2) return text('Error: the together step needs at least two people.');
        const frames = await smartSwitch.record((seconds ?? 10) * 1000);
        const r = checkTogether(p, frames, who);
        if (r.relaxed.length) { smartSwitch.profileChanged(); await smartSwitch.save(); }
        return json({
          step: 'together', people: who.map(id => nm[id]), frames: frames.length,
          detectedShare: Object.fromEntries(Object.entries(r.detectedShare).map(([id, v]) => [nm[id], `${Math.round(v * 100)}%`])),
          correctShotShare: `${Math.round(r.correctShotShare * 100)}%`,
          result: r.hidden.length ? 'CHECK' : 'GOOD',
          warnings: r.warnings,
          next: 'Review with step "summary", then atem_smart_switch_on (simulate:true first if you want to watch its decisions without cutting).',
        });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'atem_smart_meters',
    {
      title: 'Smart Switch Meters',
      description: `Live snapshot of every smart-switch mic: level, envelope, noise floor, voice threshold, the bleed expected from others, and whether the engine hears the person's own voice / considers them talking. Starts metering if needed. Use to check mic mapping ("talk into each mic") and why a cut did or didn't happen.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        await startMeters();
        const s = smartSwitch.status();
        return json({ mics: s.mics, decision: s.decision, meters: s.meters });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'atem_smart_switch_on',
    {
      title: 'Smart Switch On',
      description: `Start bleed-aware automatic switching with the active profile: cuts to the tightest camera that shows whoever is talking, goes to a group/wide shot when several people talk together long enough, follows the silence and variety rules, and pauses after any manual cut (from the panel, ATEM Software Control or another tool).

simulate: true runs the full engine and logs the cuts it WOULD make without touching the ATEM — good for a rehearsal.
Cannot run at the same time as the classic atem_auto_switch_on.`,
      inputSchema: {
        simulate: z.boolean().default(false).describe('Decide and log cuts without sending them'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ simulate }) => {
      try {
        const p = smartSwitch.profile();
        const problems = profileProblems(p);
        if (problems.length) return text(`Can't start: ${problems.join(' ')}`);
        const err = await smartSwitch.start({ simulate });
        if (err) return text(err);
        const learnedPairs = Object.values(p.learned.bleedDb).reduce((n, row) => n + Object.keys(row).length, 0);
        const total = p.mics.filter(m => m.enabled).length;
        return text(`Smart switch ${simulate ? 'SIMULATING (no cuts sent)' : 'ON'} — profile "${p.name}", speed ${p.speed}, ${total} mics, ${p.cameras.length} cameras, transition ${p.rules.transition}.`
          + `\nBleed learned for ${learnedPairs} of ${total * (total - 1)} mic pairs${learnedPairs === 0 ? ' — run atem_smart_calibrate for best results (falling back to ignoring weak mics)' : ''}.`
          + '\nUse atem_smart_switch_status to watch decisions, atem_smart_switch_off to stop.');
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'atem_smart_switch_off',
    {
      title: 'Smart Switch Off',
      description: 'Stop the smart switch. Meters keep running until the server restarts; learned bleed is saved.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      if (!smartSwitch.isSwitching()) return text('The smart switch is not running.');
      const sim = smartSwitch.isSimulating();
      const r = smartSwitch.stop();
      return text(`Smart switch stopped after ${r.seconds}s with ${r.cuts} ${sim ? 'simulated ' : ''}cuts.`);
    }
  );

  server.registerTool(
    'atem_smart_switch_status',
    {
      title: 'Smart Switch Status',
      description: 'Whether the smart switch is running, what it wants on air and why (or what is holding it back), who is talking, per-mic levels, seconds on air per camera, and the recent cut log.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => json(smartSwitch.status())
  );

  server.registerTool(
    'atem_smart_resume',
    {
      title: 'Resume Smart Switch',
      description: 'End the pause after a manual cut so the smart switch decides again right away.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      smartSwitch.releaseHold();
      return text('Pause ended: the smart switch is deciding again.');
    }
  );
}
