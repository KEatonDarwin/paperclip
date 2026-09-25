import type { ToolDef } from './index.js';
import {
  healthNow,
  seriesPoints,
  listHealthEvents,
  ackHealthEvent,
  workloadRows,
  listHealthEventsInWindow,
  isHealthWindow,
  HEALTH_WINDOWS,
  type HealthWindow,
} from '../health-monitor.js';

// 🩺 COCKPIT HEALTH (docs/health/CONTRACT.md §8) — how JARVIS reads the box from
// any thread, so "the cockpit feels laggy" stops being a guess.
//
// THE RULE baked into the description: this tool has NO op that can change a
// dial, and that is deliberate, not an oversight. The whole point of the spike →
// suggestion loop is that JARVIS explains and RECOMMENDS; Kevin turns the dial
// (see throttle-tool.ts for the same line, drawn the same way). `ack`/`suggest`
// write a note onto a spike row and nothing else.
export const health: ToolDef = {
  name: 'health',
  description:
    "Kevin's 🩺 Cockpit Health monitor — the actual working computer: CPU, memory, EVENT-LOOP LAG (the number that explains why the cockpit feels laggy — a 1.5GB jarvis.db stalling synchronous sqlite reads was the real cause once, and nothing in `top` showed it), disk, jarvis.db size + free pages + row writes/min + API requests/min, claude CLI process count, and a full snapshot of WHAT WAS RUNNING (hopper workers with adapter/model, turns in flight, the active shift, autopilot goals, provider/account meters, throttle dials and the governor hold reason). Call 'now' whenever Kevin says things feel slow or asks what's going on with the box; 'series' for the shape of a spike over time (window 15m|1h|6h|24h|7d|30d — raw points under an hour, 1-minute rollups to a day, hourly beyond); 'workloads' for the clickable per-subsystem status rows; 'events' for spike history WITH the workload snapshot captured at that instant plus whatever suggestion was written. When a spike cue lands in the 🩺 Health monitor thread, read the snapshot, write Kevin 3–5 lines naming the likely cause and the ONE setting you would change (exact key and value), and store it with 'ack' {event_id, suggestion}. NEVER change a dial off the back of a spike — this surface is suggestions only, and this tool has no op that could. All reads are free and cost nothing.",
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['now', 'series', 'workloads', 'events', 'ack', 'suggest'],
        description: 'What to do. now/series/workloads/events are free reads.',
      },
      window: {
        type: 'string',
        enum: HEALTH_WINDOWS,
        description: 'For series: 15m|1h|6h|24h|7d|30d (default 1h). Resolution is chosen server-side.',
      },
      metrics: {
        type: 'string',
        description: "For series: advisory comma list, e.g. 'cpu,lag,claude'. Points always carry every field.",
      },
      limit: { type: 'number', description: 'For events: how many, default 50, max 500.' },
      metric: { type: 'string', description: "For events: filter to one metric ('cpu' | 'mem' | 'lag' | 'disk')." },
      kind: { type: 'string', description: "For events: filter to 'spike' | 'release' | 'note'." },
      event_id: { type: 'number', description: 'For ack/suggest: the health event id from the cue.' },
      suggestion: {
        type: 'string',
        description: 'For ack/suggest: your 3–5 line suggestion. Name the exact setting and value you would change — and do not change it yourself.',
      },
    },
    required: ['operation'],
  },
  execute: async (args) => {
    const op = typeof args.operation === 'string' ? args.operation : '';

    if (op === 'now') return healthNow();

    if (op === 'series') {
      const raw = typeof args.window === 'string' && args.window.trim() !== '' ? args.window.trim() : '1h';
      if (!isHealthWindow(raw)) return { error: `window must be one of: ${HEALTH_WINDOWS.join(', ')}` };
      const series = seriesPoints(raw as HealthWindow);
      const metrics = typeof args.metrics === 'string' && args.metrics.trim() !== ''
        ? args.metrics.split(',').map((m) => m.trim()).filter(Boolean)
        : ['cpu', 'mem', 'lag', 'disk', 'db', 'claude'];
      return {
        window: raw,
        resolution: series.resolution,
        from: series.from,
        to: series.to,
        metrics,
        points: series.points,
        events: listHealthEventsInWindow(series.from, series.to),
      };
    }

    if (op === 'workloads') return workloadRows();

    if (op === 'events') {
      const limit = typeof args.limit === 'number' ? args.limit : 50;
      return {
        events: listHealthEvents({
          limit,
          metric: typeof args.metric === 'string' && args.metric.trim() !== '' ? args.metric.trim() : undefined,
          kind: typeof args.kind === 'string' && args.kind.trim() !== '' ? args.kind.trim() : undefined,
        }),
      };
    }

    if (op === 'ack' || op === 'suggest') {
      const id = typeof args.event_id === 'number' ? args.event_id : NaN;
      if (!Number.isFinite(id)) return { error: 'event_id is required (the number in the cue header, e.g. [health spike #12])' };
      const suggestion = typeof args.suggestion === 'string' ? args.suggestion : undefined;
      if (op === 'suggest' && (!suggestion || suggestion.trim() === '')) {
        return { error: 'suggest needs a suggestion — use ack if you only mean to mark it seen' };
      }
      const event = ackHealthEvent(id, suggestion);
      if (!event) return { error: `no health event ${id}` };
      return { ok: true, event };
    }

    return { error: `unknown operation: ${op || '(none)'}` };
  },
};
