# Jam Tentacle Sync to the ATEM's timecode

> **Untested on real hardware.** The USB protocol was reverse-engineered from Tentacle Setup 3.00, and the
> packet encoding and timing math are covered by unit tests. It has not yet been run against a real
> Tentacle or ATEM. Do a test jam and check it before relying on it for a show.

For an EDL to conform in Resolve, the camera files need the same timecode as the switcher. These tools set
Tentacle Sync timecode generators (Sync, Sync E, Track E) to the ATEM's timecode over USB, the same way
the Tentacle Setup app does when you press "Sync". The difference is that the source is the switcher
instead of the Mac clock.

## Use

1. **Quit Tentacle Setup.** It holds the same USB interface.
2. Connect the switcher (`atem_connect`), then plug each Tentacle into the Mac with a USB cable and switch it on.
3. Say *"jam the Tentacles"* (`atem_tentacle_jam`). For each unit, the tool:
   - sets its frame rate to match the switcher,
   - waits for the next frame boundary and sends that frame's timecode, adjusted for the measured USB latency,
   - reads the timecode back three times and reports how many frames it is ahead or behind,
   - re-jams once, with the correction applied, if it is off by one frame or more.
4. Unplug the Tentacles and mount them on the cameras. They free-run on their own clock.
5. To check for drift later, plug a Tentacle back in and say *"Tentacle status"* (`atem_tentacle_status`).

Options: `set_frame_rate` (default on), `offset_frames` to add a fixed offset, `auto_correct` (default on).

## Frame rates

| Switcher | Tentacle |
|---|---|
| 23.98 / 24 / 25 / 29.97 / 30 | same |
| 50p | 25 |
| 59.94p | 29.97 (DF if the switcher is DF) |

Tentacles run timecode at up to 30 fps, so high-frame-rate switchers are jammed at half rate. That is
the usual convention for camera timecode.

## Protocol (from TTUsb.framework in Tentacle Setup 3.00)

- USB VID `0x16D0`. Normal operating PIDs are `0x081C` (interface 0) and `0x0D40` / `0x0D42` (interface 1).
  `0x0D41` is the firmware-update bootloader and is never opened.
- Interrupt OUT endpoint `0x02` and IN endpoint `0x81`, 3 s timeout.
- 36-byte packets: `[cmd, 0xFF, len lo, len hi, payload (up to 32 bytes)]`. The reply echoes `cmd`, byte 1
  is `0` on success, and the payload starts at byte 4.

| Command | Code | Payload |
|---|---|---|
| Set timecode | `0xA7` | `HH MM SS FF` (up to 23:59:59:29) |
| Get timecode | `0x27` | reply: `HH MM SS FF` |
| Set frame rate | `0xA5` | `fps`, `ntsc` (rate ÷ 1.001), `dropFrame` |
| Get frame rate | `0x25` | reply: same 3 bytes |
| Get mode | `0x24` | reply: mode byte |

No authentication is needed. Tentacle Setup never calls the device's challenge-response command.

## Troubleshooting

- **"Cannot claim Tentacle USB interface"**: Tentacle Setup (or another app) still has the device open. Quit it.
- **"No Tentacle Sync found on USB"**: check the cable carries data, and that the Tentacle is on.
- **"The switcher did not report its timecode"**: needs ATEM firmware 8.0 or later.
- **Consistently one frame off**: the device may latch the timecode on the next frame. Pass
  `offset_frames: -1` (or `+1`), or leave `auto_correct` on, which applies the measured correction.
