import { DEFAULTS, endpointFor, apiKeyRequired, withDefaults } from './src/config.js';

const el = (id) => document.getElementById(id);
const fields = ['cockpitBase', 'apiBase', 'apiKey'];

function read() {
  return {
    cockpitBase: el('cockpitBase').value,
    apiBase: el('apiBase').value,
    apiKey: el('apiKey').value,
    enabled: el('enabled').checked,
  };
}

function say(text, kind = '') {
  const s = el('status');
  s.textContent = text;
  s.className = kind;
}

/** Live readout of where lookups actually go — no guessing about the proxy rule. */
function reflect() {
  const settings = read();
  const endpoint = endpointFor(settings, 'lookup');
  el('resolved').innerHTML = endpoint
    ? `<code>${endpoint.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</code>`
    : '<code>—</code> &nbsp;<span class="k">(no usable base URL)</span>';
  el('keyHint').textContent = !endpoint
    ? 'Set a cockpit base URL first.'
    : apiKeyRequired(settings)
      ? 'Required on this path — talking straight to JARVIS. Find it as JARVIS_COCKPIT_KEY in jarvis-command-center/.env.'
      : 'Optional on the /cockpit-api path — the cockpit injects its own key server-side. Harmless to set anyway.';
}

async function load() {
  const settings = withDefaults(await chrome.storage.local.get(null));
  for (const f of fields) el(f).value = settings[f];
  el('enabled').checked = settings.enabled;
  reflect();
}

el('save').addEventListener('click', async () => {
  const settings = read();
  await chrome.storage.local.set(settings);
  reflect();
  say(endpointFor(settings, 'lookup') ? 'Saved.' : 'Saved, but no usable base URL — nothing will be looked up.',
      endpointFor(settings, 'lookup') ? 'ok' : 'bad');
});

el('test').addEventListener('click', async () => {
  const settings = read();
  const endpoint = endpointFor(settings, 'lookup');
  if (!endpoint) return say('No usable base URL.', 'bad');

  say('Testing…');
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      // The cockpit itself — a page that is definitionally ours, so a healthy
      // server answers ours:true and this doubles as a registry sanity check.
      body: JSON.stringify({ url: `${settings.cockpitBase || DEFAULTS.cockpitBase}/` }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return say(`HTTP ${res.status} — ${(await res.text()).slice(0, 180)}`, 'bad');
    const data = await res.json();
    say(`Connected. ${data.ours ? `ours · ${data.project ?? 'no project name'} · ${(data.threads ?? []).length} chat(s)` : 'reachable, but that URL is not in the registry'}`, 'ok');
  } catch (err) {
    say(`Failed: ${err instanceof Error ? err.message : String(err)}`, 'bad');
  }
});

for (const f of fields) el(f).addEventListener('input', reflect);
load();
