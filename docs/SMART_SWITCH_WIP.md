# Smart switch — work in progress (paused 2026-10-24)

Bleed-aware automatic switching (OnAirCut-style), milestones 1–4. Branch `feature/smart-switch`.
The classic `atem_auto_switch_*` code is untouched apart from a guard so the two switchers never run at once.

## Done
- `src/smart/types.ts`: profile/mic/camera/rules types, speed presets, defaults, `profileProblems`, dB helpers
- `src/smart/engine.ts`: pure, clock-injected `SwitchEngine`. Envelope, noise floor, own voice vs expected bleed
  (with a weak-mic fallback before bleed is learned), attack/release, adaptive bleed learning, a chooser
  (tightest shot, group/wide, dominance, silence, variety), and guards (confirm delay, min shot, manual-cut pause,
  respect non-camera sources)
- `src/smart/audio-device.ts`: USB mixer capture via `ffmpeg -f avfoundation` → per-channel 10 ms RMS (dBFS)
- `src/smart/calibration.ts`: noise / speaker-alone / together steps (pure, frame-based)
- `src/smart/profile-store.ts`: JSON config at `~/Library/Application Support/atem-mcp-server/smart-switch.json`
  (override with `SMART_SWITCH_CONFIG`)
- `src/smart/controller.ts`: 50 ms tick loop, ATEM Fairlight + device levels, simulation mode, cut log, saves learned values
- `src/tools/smart-switch.ts`: 9 MCP tools (`atem_smart_audio_devices`, `_setup`, `_profile`, `_calibrate`, `_meters`,
  `_switch_on` / `_off` / `_status`, `_resume`), registered in `src/index.ts`
- `src/services/atem-connection.ts`: `onSourceLevel()` hook, `isAutoSwitchRunning()`, `setOtherSwitcherCheck()`
- `test/smart-switch.test.mjs` + `npm test`: **12 of 13 pass**

## Next
1. **Fix the failing variety test.** The cutaway never fires. Likely cause: the variety condition needs the
   speaker's `ownVoice` to be false for ≥ `VARIETY_PAUSE_MS` (250 ms), but the envelope (120 ms hold, then
   30 dB/s decay) bridges the 250 ms syllable dips in the synthetic room, so a pause is never seen. Options:
   judge the pause on the raw level vs threshold instead of the envelope, or lower `VARIETY_PAUSE_MS`.
2. Add a README section and a user guide (`docs/SMART_SWITCH.md`); update the tool counts in README/index comments.
3. Test against real hardware: `atem_smart_audio_devices` → `atem_smart_setup` → calibrate → `atem_smart_switch_on simulate:true`.
   Check the ATEM Fairlight level rate and how macOS mic permission behaves for the process that runs the server.
4. Later milestones: session recording (per-mic WAV + cuts), offline Viterbi cut planner, sync, export/Resolve build.
