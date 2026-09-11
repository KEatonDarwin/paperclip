import { getSetting } from './conversation-db.js';

export type FoundryModelPurpose = 'planner' | 'build' | 'test' | 'doc';

function normalizeSettingKey(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith('foundry_') ? trimmed : `foundry_${trimmed}`;
}

function envKeyFor(settingKey: string): string {
  return settingKey.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

export function getFoundrySetting(name: string): string | null {
  const settingKey = normalizeSettingKey(name);
  const kv = getSetting(settingKey)?.trim();
  if (kv) return kv;
  return process.env[envKeyFor(settingKey)]?.trim() || null;
}

export function getFoundryModelSetting(purpose: FoundryModelPurpose, fallback: string): string {
  return getFoundrySetting(`${purpose}_model`) ?? fallback;
}
