import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAtem } from '../services/atem-connection.js';
import { edlLogger, AtemLike } from '../services/edl-logger.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export function registerEdlTools(server: McpServer): void {

  server.registerTool(
    'atem_edl_start',
    {
      title: 'Start EDL Logging',
      description: `Start logging every program switch on an M/E bus to a CMX 3600 EDL for DaVinci Resolve.
Captures switches from any source (hardware panel, ATEM Software Control, Claude, auto-switch).
The .edl file is rewritten after every switch, so it is always up to date on disk.

Use when the user says things like "start the EDL", "log this show", "start recording the cuts".

Args:
  - title: show/episode name used in the EDL and filename
  - me: M/E bus to log (0 = M/E 1, the main program output)
  - tc_source: "atem" (switcher's timecode, default) or "clock" (Mac time-of-day). Use whichever matches the timecode recorded in the camera files.
  - drop_frame: override drop-frame (default: drop-frame at 29.97/59.94)
  - record_start_tc: timeline start timecode (default 01:00:00:00)
  - reel_names: map of ATEM input number to reel name, e.g. {"1":"CAM1","2":"CAM2"}. Default is each input's short name.
  - output_dir: folder for the files (default ~/Movies/ATEM EDLs)`,
      inputSchema: {
        title: z.string().optional().describe('Show or episode name'),
        me: z.number().int().min(0).max(3).default(0).describe('M/E bus (0=ME1)'),
        tc_source: z.enum(['atem', 'clock']).default('atem').describe('Timecode source'),
        drop_frame: z.boolean().optional().describe('Force drop-frame on/off'),
        record_start_tc: z.string().optional().describe('Timeline start TC, default 01:00:00:00'),
        reel_names: z.record(z.string()).optional().describe('Input number -> reel name'),
        output_dir: z.string().optional().describe('Output folder'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, me, tc_source, drop_frame, record_start_tc, reel_names, output_dir }) => {
      const file = await edlLogger.start(getAtem() as unknown as AtemLike, {
        title, me, tcSource: tc_source, dropFrame: drop_frame, recordStartTc: record_start_tc,
        reelNames: reel_names, outputDir: output_dir,
      });
      const s = edlLogger.status();
      return text(`EDL logging started on M/E ${s.me} — ${s.frameRate} fps ${s.dropFrame ? 'DF' : 'NDF'}, timecode from ${s.timecodeSource === 'atem' ? 'the switcher' : 'the Mac clock'} (now ${s.currentTimecode}).${s.note ? '\n⚠️ ' + s.note : ''}\nWriting to: ${file}`);
    }
  );

  server.registerTool(
    'atem_edl_stop',
    {
      title: 'Stop EDL Logging',
      description: 'Stop EDL logging and finalize the .edl file (and markers EDL if any markers were added). Returns file paths for import into DaVinci Resolve.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      const r = await edlLogger.stop();
      return text(`EDL finished: ${r.events} switches over ${r.length}.\nEDL: ${r.edl}${r.markers ? `\nMarkers: ${r.markers}` : ''}`);
    }
  );

  server.registerTool(
    'atem_edl_marker',
    {
      title: 'Add EDL Marker',
      description: 'Drop a timeline marker at the current moment while EDL logging (e.g. "mark that", "clip that for social"). Exported as a Resolve markers EDL.',
      inputSchema: { note: z.string().default('Marker').describe('Marker note') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ note }) => {
      const tc = await edlLogger.addMarker(note);
      return text(`Marker "${note}" added at ${tc} (timeline).`);
    }
  );

  server.registerTool(
    'atem_edl_status',
    {
      title: 'EDL Logging Status',
      description: 'Show whether EDL logging is running, the current timecode, number of switches and markers logged, and the output file.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => text(JSON.stringify(edlLogger.status(), null, 2))
  );
}
