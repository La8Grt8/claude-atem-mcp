# Smart Switch

Smart Switch cuts your ATEM to whoever is talking. The difference from the classic `atem_auto_switch` is that it
knows how much each person's voice **bleeds** into the other mics, so a loud guest leaking into the host's mic
doesn't steal the shot.

There are two ways to run it, and both use the same engine and the same saved settings:

- **The standalone app** (`npm run smart-switch`) opens a control panel in your browser. No Claude needed.
- **The MCP tools** (`atem_smart_*`) let you set it up and run it by talking to Claude.

> [!WARNING]
> **Untested on real hardware.** The engine is covered by automated tests on synthetic audio, but it has not yet
> run a real show. Rehearse in **Simulate** mode first.

## Quick start (standalone app)

```bash
cd ~/mcp-servers/atem-mcp-server
npm install --include=dev && npm run build
npm run smart-switch -- --atem 192.168.1.240
```

You can also double-click **`Smart Switch.command`** in the repo folder. It builds on the first run, then starts the
app. The control panel opens at <http://localhost:3020>.

1. **Setup tab:** choose where the mics come from and who is on which camera.
   - **USB mixer:** click *Find mixers*, pick the device, and give each person a channel number (1 = first channel).
   - **ATEM audio inputs:** set each person's source to *ATEM audio input* and enter the input number. This uses the
     ATEM's Fairlight meters, so no mixer needs to be plugged into the Mac.
   - **Cameras:** add each ATEM input that's a camera and tick who is visible in it. Tick everyone on the wide shot.
   - Click **Save setup**. Talk into each mic and check that the matching meter lights up.
2. **Calibrate tab:** run the three steps with everyone seated (about a minute; see below).
3. **Rehearse:** tick **Simulate** and press **AUTO**. The engine decides and logs cuts, but nothing is sent to the
   ATEM. The camera it would put up is marked *ON AIR (SIM)*.
4. **Go live:** untick Simulate and press **AUTO** (or ⌘↩).

Keys **1–9** cut to that camera by hand. ⌘↩ (Ctrl+Enter) turns AUTO on and off. After a manual cut, or one made on
the ATEM panel or in ATEM Software Control, AUTO pauses so your decision sticks. *Resume auto* ends the pause early.

### App options

| Option | Default | |
|---|---|---|
| `--atem <ip>` | last used | ATEM address (also settable in the panel, or with `ATEM_HOST`) |
| `--port <n>` | 3020 | Control panel port (`SMART_SWITCH_PORT`) |
| `--lan` | off | Let other devices on the network (an iPad, say) open the panel. **There is no login**, so only use it on a network you trust. |
| `--no-open` | off | Don't open the browser on start |

Settings, profiles and calibration are saved to
`~/Library/Application Support/atem-mcp-server/smart-switch.json` (override with `SMART_SWITCH_CONFIG`). The
previous version is kept as `smart-switch.bak.json`.

Don't run AUTO in the app and in Claude at the same time. They would both try to cut.

## Calibration

Calibration measures each mic's background noise, and how loud each person sounds in everyone else's mic.

1. **Quiet, please:** nobody talks for 8 s.
2. **Each person alone:** only that person talks for 10 s in their normal voice. Repeat for everyone. If the app hears
   them on a different mic, it tells you, which usually means the channel mapping is wrong. Tick *Put their camera
   on air* to see who you're calibrating.
3. **Everyone at once:** everyone talks over each other for 10 s. The app replays this and checks that nobody gets
   hidden. If someone does, it loosens their bleed filter and tells you.

The **bleed table** shows the result. Each row is a person's voice; each column is a mic. For example, `-18 dB`
means that voice reaches the other mic 18 dB quieter than it does in its own mic. Amber values (above −6 dB) mean
the two mics hear almost the same thing: move the mics closer to their people or further apart.

You can skip calibration. Until a pair is learned, the app ignores any mic more than 10 dB below the loudest one
(*Ignore mics this far below the loudest*). With *Keep learning during the show* on, it also learns bleed live
whenever one person clearly talks alone.

## How it decides

Every 50 ms, for each mic:

1. **Level:** an envelope that follows syllables without dropping out between them.
2. **Voice threshold:** the mic's noise floor plus *Voice above noise floor* (12 dB), or a fixed threshold if you set one.
3. **Own voice:** the mic must also beat the bleed it should be getting from everyone else who's loud, plus
   *Margin over expected bleed* (6 dB).
4. **Talking:** own voice for *Voice start* begins a turn; *Voice end* of silence ends it.

Then it picks a shot:

| Who's talking | Shot |
|---|---|
| One person | The tightest camera that shows them |
| Several people, for at least *Talking together for at least* | **The wide shot** (default), or with *Go to: Tightest shot showing them all*, a two-shot that covers exactly them |
| Several people, not yet long enough | Stays on the current shot if it shows one of them. One person much louder than the others counts as the speaker |
| Nobody, for *After* | *Stay* (default), *Go to the wide*, or *Go to a chosen camera* |
| One person for longer than the variety time | Briefly cuts to the wide at a natural pause, then back (*Variety*; 0 turns it off) |

Before cutting, the new shot has to hold for *Confirm the new shot*, and no shot is shorter than *Minimum time per
shot*. AUTO never cuts while you're on something that isn't a camera (a logo, black, the media player) until you cut
back to a camera yourself.

### Several people → wide shot

By default, when **2 or more** people talk at once for **2.5 s**, it goes to the wide shot. In the Rules tab:

- **From how many people:** raise it to 3 if two-person cross-talk shouldn't open the wide.
- **Talking together for at least:** lower it (even to 0) to go wide sooner. Raise it if quick "uh-huh"s open the wide.
- **Go to:** *The wide shot*, or *Tightest shot showing them all* if you have two-shots.

### Speed presets

| Speed | Minimum shot | Confirm | Voice start | Voice end |
|---|---|---|---|---|
| Very fast | 1.2 s | 0.15 s | 0.15 s | 0.6 s |
| Fast | 2 s | 0.25 s | 0.2 s | 0.9 s |
| Normal | 3 s | 0.4 s | 0.3 s | 1.3 s |
| Calm | 5 s | 0.7 s | 0.5 s | 2 s |

## With Claude (MCP tools)

| Tool | What it does |
|---|---|
| `atem_smart_audio_devices` | List USB mixers / audio interfaces |
| `atem_smart_setup` | Mics, cameras, speed and rules (only the fields you pass change) |
| `atem_smart_profile` | List, get, use, create and delete show profiles |
| `atem_smart_calibrate` | Steps `noise`, `speaker` (per person), `together`, `summary` |
| `atem_smart_meters` | Live per-mic levels and why each one is or isn't counted as voice |
| `atem_smart_switch_on` | Start (`simulate: true` to rehearse without cutting) |
| `atem_smart_switch_off` | Stop |
| `atem_smart_switch_status` | What it wants on air and why, who's talking, time on air, recent cuts |
| `atem_smart_resume` | End the pause after a manual cut |

Example: *"Set up the smart switch: Rob on mixer channel 1, Ana on channel 2. Camera 1 is the wide with both, 2 is
Rob, 3 is Ana. Then calibrate us."*

## Troubleshooting

- **Meters don't move (USB mixer):** check the device in Setup. macOS must allow microphone access for the app that
  started Smart Switch (Terminal, or Claude for the MCP tools): System Settings → Privacy & Security → Microphone.
  The app reads the mixer through `ffmpeg` (`brew install ffmpeg`, or set `FFMPEG_PATH`).
- **Meters don't move (ATEM inputs):** the ATEM must be connected, and it needs Fairlight audio (Mini Extreme,
  Constellation, and similar). Classic-audio models don't send per-input levels.
- **It cuts to the wrong person when someone is loud:** run calibration, or raise *Margin over expected bleed*.
- **Someone is never detected:** check their meter's yellow threshold. Lower *Voice above noise floor*, re-run the
  *Everyone at once* step, or move their mic closer.
- **Too many cuts:** pick a calmer speed, or raise *Minimum time per shot*.
- **"Port 3020 is busy":** Smart Switch is already running. Open <http://localhost:3020>, or start with `--port`.
