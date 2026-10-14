# EDL logging for DaVinci Resolve

> [!WARNING]
> **Untested on real hardware.** The EDL logging feature and the Links Live Media additions have not yet been tested with a
> real ATEM switcher (including the Constellation 4K) or conformed in DaVinci Resolve. They have only been checked against a
> simulated switcher (`test-edl-sim.mjs`). Don't rely on this for a live show until you've run your own test session.
> Feedback and bug reports are welcome in [Issues](https://github.com/La8Grt8/claude-atem-mcp/issues).

Logs every program switch on an M/E bus and writes a CMX 3600 EDL, for switchers
without ISO recording (e.g. Constellation 4K). Captures switches from the panel,
ATEM Software Control, Claude or auto-switch. Files are rewritten after every switch.

## Tools
| Tool | Say something like |
|---|---|
| `atem_edl_start` | "Start the EDL for Episode 12" |
| `atem_edl_marker` | "Mark that — great clip" |
| `atem_edl_status` | "Is the EDL running?" |
| `atem_edl_stop` | "Stop the EDL" |

Output: `~/Movies/ATEM EDLs/<Title>_<date>_<time>.edl` (+ `_markers.edl`, `.json` log).

## Before the show
1. **Timecode must match.** The EDL's source timecode comes from the switcher's clock
   (or the Mac clock with `tc_source: clock`). Every camera/recorder must record the
   same time-of-day timecode — jam-sync them, or set all devices and the ATEM to time of day.
2. **Reel names.** Each event's reel = the ATEM input short name (CAM1, CAM2…), or pass
   `reel_names` e.g. `{"1":"CAM1","2":"CAM2"}`. Black = `BL`.
3. Start the logger *after* cameras are rolling, stop it *before* they stop.

## In Resolve
1. Import all camera files into the Media Pool. Set each clip's **Reel Name**
   (Clip Attributes → Name → Reel name, or Project Settings → General Options →
   "Assist using reel names from").
2. File → Import → Timeline → select the `.edl`; choose the clips folder, enable
   reel-name matching. Resolve conforms each cut by reel + source timecode.
3. Markers: right-click the timeline → Timelines → Import → Timeline Markers from EDL
   → `_markers.edl`.

## Limits
- Program bus only: keyers/DSK graphics and Super Source composites are logged as their
  source (e.g. SuperSource `6000`) — record those outputs separately (e.g. an aux recorder)
  if you need them.
- Mix/dip/wipe/DVE transitions are written as dissolves with the measured duration.
- Simulated test: `node test-edl-sim.mjs` (after `npm run build`).
