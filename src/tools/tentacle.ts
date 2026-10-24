import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAtem, isAtemConnected } from '../services/atem-connection.js';
import { AtemLike } from '../services/edl-logger.js';
import { checkTentacles, jamTentacles, DeviceReport } from '../services/tentacle-jam.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function describe(r: DeviceReport): string {
  if (r.error) return `• ${r.device}: ❌ ${r.error}`;
  const off = r.offsetFrames === undefined ? ''
    : r.offsetFrames === 0 ? ' — in sync with the switcher'
    : ` — ${r.offsetFrames > 0 ? 'ahead' : 'behind'} by ${Math.abs(r.offsetFrames)} frame${Math.abs(r.offsetFrames) === 1 ? '' : 's'}`;
  return `• ${r.device}: ${r.timecode ?? '?'} @ ${r.frameRate}${r.jammedTo ? ` (jammed to ${r.jammedTo})` : ''}${off}`;
}

export function registerTentacleTools(server: McpServer): void {

  server.registerTool(
    'atem_tentacle_jam',
    {
      title: 'Jam Tentacle Sync to ATEM Timecode',
      description: `Jam-sync every Tentacle Sync connected to this Mac by USB to the ATEM switcher's timecode,
so camera files carry the same timecode as the switcher (needed for EDL conforms in Resolve).
Sets each Tentacle's frame rate to match the switcher, sends the timecode on a frame boundary,
reads it back, and corrects once if it landed a frame off.

Use when the user says "jam the Tentacles", "sync timecode to the switcher", "set the Tentacle to the ATEM".
Quit the Tentacle Setup app first — both use the same USB interface.
After jamming, unplug the Tentacle and connect it to the camera; it free-runs on its own clock.

Args:
  - set_frame_rate: also set the Tentacle frame rate to match the switcher (default true).
    50p/59.94p switchers are jammed at 25/29.97, since Tentacles run timecode at up to 30 fps.
  - offset_frames: frames to add to the jammed timecode, for a known fixed offset (default 0)
  - auto_correct: re-jam once if the read-back is a frame or more off (default true)`,
      inputSchema: {
        set_frame_rate: z.boolean().default(true).describe('Match Tentacle frame rate to the switcher'),
        offset_frames: z.number().int().min(-30).max(30).default(0).describe('Frames added to the jammed timecode'),
        auto_correct: z.boolean().default(true).describe('Re-jam once if a frame or more off'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ set_frame_rate, offset_frames, auto_correct }) => {
      const r = await jamTentacles(getAtem() as unknown as AtemLike, {
        setFrameRate: set_frame_rate, offsetFrames: offset_frames, autoCorrect: auto_correct,
      });
      return text([
        `Switcher: ${r.atemTimecode} @ ${r.atemRate} → Tentacle rate ${r.tentacleRate}`,
        ...r.reports.map(describe),
      ].join('\n'));
    }
  );

  server.registerTool(
    'atem_tentacle_status',
    {
      title: 'Tentacle Sync Status',
      description: `List Tentacle Sync devices connected by USB with their current timecode and frame rate.
If the switcher is connected, also shows how many frames each Tentacle is ahead or behind it (drift check).
Makes no changes. Quit the Tentacle Setup app first.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const r = await checkTentacles(isAtemConnected() ? getAtem() as unknown as AtemLike : null);
      if (!r.reports.length) return text('No Tentacle Sync found on USB. Connect it with a USB cable and switch it on.');
      return text([
        r.atemTimecode ? `Switcher: ${r.atemTimecode}` : 'Switcher timecode unavailable (not connected or not reported).',
        ...r.reports.map(describe),
      ].join('\n'));
    }
  );
}
