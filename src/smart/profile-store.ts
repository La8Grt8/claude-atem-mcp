// ---------------------------------------------------------------------------
// Smart switch config on disk — profiles, mics, cameras, rules and everything
// learned during calibration. Written atomically, keeping the previous copy as
// smart-switch.bak.json. Location: SMART_SWITCH_CONFIG, or
// ~/Library/Application Support/atem-mcp-server/smart-switch.json.
// ---------------------------------------------------------------------------

import { promises as fs, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_RULES, Profile, SmartSwitchConfig, emptyLearned, newProfile } from './types.js';

export const CONFIG_PATH = process.env.SMART_SWITCH_CONFIG
  || path.join(os.homedir(), 'Library', 'Application Support', 'atem-mcp-server', 'smart-switch.json');

function defaults(): SmartSwitchConfig {
  return { version: 1, activeProfile: 'Default', audioDevice: null, profiles: [newProfile('Default')] };
}

/** Fill in fields added after a profile was saved, so older files keep loading. */
function sanitize(p: Partial<Profile> & { name: string }): Profile {
  const base = newProfile(p.name);
  return {
    ...base,
    ...p,
    rules: { ...DEFAULT_RULES, ...(p.rules ?? {}) },
    learned: { ...emptyLearned(), ...(p.learned ?? {}) },
    mics: (p.mics ?? []).map(m => ({ ...m, enabled: m.enabled ?? true, manualThresholdDb: m.manualThresholdDb ?? null })),
    cameras: p.cameras ?? [],
  };
}

export function loadConfig(): SmartSwitchConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as SmartSwitchConfig;
    const profiles = (raw.profiles ?? []).map(sanitize);
    if (profiles.length === 0) return defaults();
    const active = profiles.some(p => p.name === raw.activeProfile) ? raw.activeProfile : profiles[0].name;
    return { version: 1, activeProfile: active, audioDevice: raw.audioDevice ?? null, profiles };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[smart-switch] Could not read ${CONFIG_PATH}, starting from defaults:`, e);
    }
    return defaults();
  }
}

export async function saveConfig(cfg: SmartSwitchConfig): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2));
  await fs.copyFile(CONFIG_PATH, CONFIG_PATH.replace(/\.json$/, '.bak.json')).catch(() => undefined);
  await fs.rename(tmp, CONFIG_PATH);
}
