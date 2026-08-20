// Plugin framework: local polling scripts surfaced in the Cockpit "Plugins" pane.
// A plugin = a small always-on watcher (systemd-driven or ad-hoc) that the UI can
// toggle on/off, inspect for status, and configure via typed actions.

export type PluginState = 'running' | 'paused' | 'attention' | 'error' | 'unknown';

export interface PluginStatus {
  id: string;
  name: string;
  description: string;
  state: PluginState;
  enabled: boolean;
  detail?: string;
  lastCheckAt?: string;
  nextCheckAt?: string;
  meta?: Record<string, string | number | boolean | null>;
  actions: PluginActionSpec[];
}

export interface PluginActionSpec {
  name: string;
  label: string;
  kind: 'button' | 'form';
  fields?: PluginFieldSpec[];
}

export interface PluginFieldSpec {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'password';
  placeholder?: string;
  required?: boolean;
}

export interface PluginActionResult {
  ok: boolean;
  message?: string;
  status?: PluginStatus;
}

export interface PluginAdapter {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  status(): Promise<PluginStatus>;
  toggle(enabled: boolean): Promise<PluginStatus>;
  action(name: string, payload: Record<string, unknown>): Promise<PluginActionResult>;
}
