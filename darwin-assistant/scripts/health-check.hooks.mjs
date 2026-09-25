// ESM stub hook for `npm run health:check` — the FIRST line of defence.
//
// src/health-monitor.ts posts the spike cue by dynamically importing agent.js and
// calling processMessage. src/sim-guard.ts would refuse it anyway (the check runs
// with JARVIS_SIM=1 on a scratch DB), but a refusal returns a marker rather than
// letting the check OBSERVE the cue — and the whole point of AC-3 is to prove
// exactly one cue went out. So stub the module: record the call, spawn nothing.
//
// Lesson banked from the 2026-09-24 critic:sim leak: a sim that isolates its
// DATABASE has not thereby isolated the MODEL. Both, every time.

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const distAgent = pathToFileURL(path.resolve(import.meta.dirname, '..', 'dist', 'agent.js')).href;

export function resolve(specifier, context, next) {
  return next(specifier, context);
}

export function load(url, context, next) {
  if (url === distAgent) {
    const source = `
      globalThis.__HEALTH_CUES__ = globalThis.__HEALTH_CUES__ ?? [];
      export class ConversationBusyError extends Error {}
      export function getInFlightMessageId() { return null; }
      export function getActiveRuns() { return []; }
      export function getActiveRunCount() { return 0; }
      export function processMessage(text, externalId, correlationKey) {
        globalThis.__HEALTH_CUES__.push({ text, externalId, correlationKey });
        return Promise.resolve('stubbed');
      }
      export function abortConversationRun() { return false; }
      export function shutdownActiveRuns() { return 0; }
      export function getAdapters() { return []; }
      export function buildToolsBlock() { return ''; }
    `;
    return { format: 'module', shortCircuit: true, source };
  }
  return next(url, context);
}
