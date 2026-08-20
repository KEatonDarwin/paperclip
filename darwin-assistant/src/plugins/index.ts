import type { PluginAdapter } from './types.js';
import { hebRxPlugin, isHebInstalled } from './heb-rx-watch.js';

export * from './types.js';

const registry = new Map<string, PluginAdapter>();

function register(a: PluginAdapter): void { registry.set(a.id, a); }

if (isHebInstalled()) register(hebRxPlugin);

export function listPluginAdapters(): PluginAdapter[] {
  return Array.from(registry.values());
}

export function getPluginAdapter(id: string): PluginAdapter | undefined {
  return registry.get(id);
}
