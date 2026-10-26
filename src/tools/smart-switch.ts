import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { smartSwitch } from '../smart/controller.js';
import { listAudioDevices } from '../smart/audio-device.js';
import {
  calibrate, calibrateShape, profileAction, profileShape, setup, setupShape, startMeters, switchOff, switchOn,
} from '../smart/actions.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (o: unknown) => text(JSON.stringify(o, null, 2));
const fail = (e: unknown) => text(`Error: ${e instanceof Error ? e.message : String(e)}`);

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
  - rules: any of min_shot_ms, switch_delay_ms, attack_ms, release_ms, group_count, group_confirm_ms, group_shot (wide = several people talking at once always go to the wide shot; tightest = the tightest camera that shows all of them), silence_action (stay|wide|camera), silence_camera, silence_ms, variety_ms (0 = off), variety_hold_ms, manual_hold_ms, respect_other_sources, transition (cut|auto), me, auto_margin_db, bleed_margin_db, weak_mic_reject_db (null = off), adaptive. Setting a timing rule switches speed to "custom".

Example: mics [{name:"Rob",channel:1},{name:"Ana",channel:2}], cameras [{input:1,name:"Wide",people:["Rob","Ana"]},{input:2,people:["Rob"]},{input:3,people:["Ana"]}]`,
      inputSchema: setupShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try { return json(await setup(args)); } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'atem_smart_profile',
    {
      title: 'Smart Switch Profiles',
      description: `Manage smart-switch profiles (one per show setup). Actions: list, get (full active profile incl. learned bleed), use (make active), create (empty, or copy_from another), delete.`,
      inputSchema: profileShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try { return json(await profileAction(args)); } catch (e) { return fail(e); }
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
      inputSchema: calibrateShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try { return json(await calibrate(args)); } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'atem_smart_meters',
    {
      title: 'Smart Switch Meters',
      description: `Live snapshot of every smart-switch mic: level, noise floor, voice threshold, the bleed expected from others, and whether the engine hears the person's own voice / considers them talking. Starts metering if needed. Use to check mic mapping ("talk into each mic") and why a cut did or didn't happen.`,
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
      description: `Start bleed-aware automatic switching with the active profile: cuts to the tightest camera that shows whoever is talking, goes to the wide (or a shared) shot when several people talk at once long enough, follows the silence and variety rules, and pauses after any manual cut (from the panel, ATEM Software Control or another tool).

simulate: true runs the full engine and logs the cuts it WOULD make without touching the ATEM — good for a rehearsal.
Cannot run at the same time as the classic atem_auto_switch_on.`,
      inputSchema: {
        simulate: z.boolean().default(false).describe('Decide and log cuts without sending them'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ simulate }) => {
      try {
        return text(`${await switchOn(simulate)}\nUse atem_smart_switch_status to watch decisions, atem_smart_switch_off to stop.`);
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
    async () => text(switchOff())
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
