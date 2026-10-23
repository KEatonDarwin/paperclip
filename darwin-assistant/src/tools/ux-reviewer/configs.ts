// JARVIS UX Reviewer — per-project capture configs (DAR-685, slice 1).
//
// A config is the portable, per-project part: base URL, key screens, the
// interaction script that reaches each STATE, and viewport set. The harness
// (capture-harness.ts) is generic; these configs are what make it "droppable
// into any app."
//
// The pilot target is the JARVIS Observability UI (:3201) — server-rendered,
// live, and the surface the reviewer<->JARVIS loop will exercise first.

import { DEFAULT_VIEWPORTS, type CaptureConfig } from './capture-harness.js';

/**
 * Pilot config: JARVIS Observability UI.
 * @param opts.baseUrl   default http://127.0.0.1:3201
 * @param opts.convId    a real conversation id for the thread-detail screen
 */
export function jarvisObsUiConfig(opts: { baseUrl?: string; convId?: string } = {}): CaptureConfig {
  const baseUrl = opts.baseUrl ?? 'http://127.0.0.1:3201';
  const convId = opts.convId ?? '';

  const screens: CaptureConfig['screens'] = [
    {
      name: 'dashboard',
      states: [
        {
          name: 'idle',
          description: 'Thread table loaded; status pill, columns aligned, timestamps human-readable.',
          steps: [{ action: 'goto', path: '/', waitUntil: 'domcontentloaded' }],
        },
        {
          name: 'full-scroll',
          description: 'Whole dashboard top-to-bottom — check long-table overflow and footer.',
          fullPage: true,
          steps: [{ action: 'goto', path: '/', waitUntil: 'domcontentloaded' }],
        },
      ],
    },
    {
      name: 'settings',
      states: [
        {
          name: 'idle',
          description: 'Settings + Runtime Descriptor panel; labels aligned, no raw markdown, no overflow.',
          steps: [{ action: 'goto', path: '/settings', waitUntil: 'domcontentloaded' }],
        },
      ],
    },
    {
      name: 'autonomy-ledger',
      states: [
        {
          name: 'idle',
          description: 'Ledger list renders; entries readable, timestamps correct, empty-state handled.',
          steps: [{ action: 'goto', path: '/autonomy-ledger', waitUntil: 'domcontentloaded' }],
        },
      ],
    },
    {
      name: 'checkins',
      states: [
        {
          name: 'idle',
          description: 'Check-ins view; cards/rows readable, no clipping.',
          steps: [{ action: 'goto', path: '/checkins', waitUntil: 'domcontentloaded' }],
        },
      ],
    },
  ];

  if (convId) {
    screens.push({
      name: 'thread-detail',
      states: [
        {
          name: 'idle',
          description:
            'Conversation transcript. First-class check: markdown MUST render (bold/italic/newlines never raw); bubbles aligned; timestamps correct; long messages do not overflow.',
          fullPage: true,
          steps: [{ action: 'goto', path: `/conversations/${convId}`, waitUntil: 'domcontentloaded' }],
        },
      ],
    });
  }

  return {
    project: 'jarvis-obs-ui',
    baseUrl,
    viewports: DEFAULT_VIEWPORTS,
    screens,
  };
}
