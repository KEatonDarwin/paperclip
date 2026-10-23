/**
 * TEAMS RADAR — the board's read layer + the per-catch chat opener.
 *
 * File-backed, not DB-backed: every catch is a JSON file written by the
 * Python sweep pipeline (verify.py/act.py) under TEAMS_RADAR_DIR (default
 * /home/kevin/teams-radar/catches). This module never writes a catch file —
 * it only reads them, and patches `chat_external_id` back in once a chat is
 * opened for the first time, so the next read already knows a chat exists.
 *
 * ACCURACY GATE: nothing here computes a verdict. The verdict + evidence on
 * each catch was written by verify.py from a real probe run; this module just
 * surfaces it.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  getConversation,
  getOrCreateConversation,
  renameConversation,
  addTurn,
} from './conversation-db.js';

export type TeamsRadarKind = 'issue' | 'question' | 'chatter';
export type TeamsRadarVerdict = 'verified_broken' | 'verified_fine' | 'cant_verify' | 'not_applicable';

export interface TeamsRadarProbe {
  type: string;
  ref?: string;
  why?: string;
}

export interface TeamsRadarProbeRan {
  cmd: string;
  started_at: string;
  ms: number;
  stdout_head?: string;
  exit: number;
  http_code?: string;
  redirect_url?: string;
  rows?: number;
  grep_found?: boolean;
}

export interface TeamsRadarAction {
  kind: string;
  kit_path: string | null;
  kit_label: string | null;
  kevin_do: string | null;
  summary: string;
}

export interface TeamsRadarCatch {
  id: string;
  chat_key: string;
  message_id: string;
  author: string;
  created_at: string;
  web_url: string;
  quote: string;
  kind: TeamsRadarKind;
  claim: string;
  subject: string;
  probe: TeamsRadarProbe;
  verdict: TeamsRadarVerdict;
  verdict_why: string;
  probe_ran?: TeamsRadarProbeRan;
  verified_at?: string;
  action?: TeamsRadarAction;
  acted_at?: string;
  chat_external_id?: string | null;
}

export interface TeamsRadarCounts {
  broken: number;
  cant_verify: number;
  fine: number;
  chatter: number;
}

const DEFAULT_DIR = '/home/kevin/teams-radar/catches';

export function catchesDir(): string {
  return process.env.TEAMS_RADAR_DIR || DEFAULT_DIR;
}

function statePath(): string {
  return path.join(catchesDir(), '..', 'state.json');
}

/** Reads every *.json file in the catches dir. A file that fails to parse or
 *  is missing a required field is skipped (logged, never thrown) — one bad
 *  write from the sweep must never blank the whole board. */
function readAllCatches(): TeamsRadarCatch[] {
  const dir = catchesDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: TeamsRadarCatch[] = [];
  for (const name of names) {
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8');
      const obj = JSON.parse(raw) as Partial<TeamsRadarCatch>;
      if (!obj || typeof obj.id !== 'string' || typeof obj.created_at !== 'string' || typeof obj.verdict !== 'string') {
        console.error(`[teams-radar] skipping ${name}: missing id/created_at/verdict`);
        continue;
      }
      out.push(obj as TeamsRadarCatch);
    } catch (err) {
      console.error(`[teams-radar] skipping ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

function toMs(iso: string): number {
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
}

export function getTeamsRadarLastSweepAt(): string | null {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const obj = JSON.parse(raw) as { updated_at?: string };
    return typeof obj.updated_at === 'string' ? obj.updated_at : null;
  } catch {
    return null;
  }
}

function countBy(catches: TeamsRadarCatch[]): TeamsRadarCounts {
  const counts: TeamsRadarCounts = { broken: 0, cant_verify: 0, fine: 0, chatter: 0 };
  for (const c of catches) {
    if (c.verdict === 'verified_broken') counts.broken += 1;
    else if (c.verdict === 'cant_verify') counts.cant_verify += 1;
    else if (c.verdict === 'verified_fine') counts.fine += 1;
    else counts.chatter += 1; // not_applicable (kind issue/question/chatter, never notified)
  }
  return counts;
}

export interface ListTeamsRadarResult {
  catches: TeamsRadarCatch[];
  counts: TeamsRadarCounts;
  last_sweep_at: string | null;
}

/** `days <= 0` means no time filter (all catches on disk). */
export function listTeamsRadarCatches(opts: { includeFine: boolean; days: number }): ListTeamsRadarResult {
  const all = readAllCatches();
  const cutoff = opts.days > 0 ? Date.now() - opts.days * 86_400_000 : null;
  const inWindow = cutoff == null ? all : all.filter((c) => toMs(c.created_at) >= cutoff);
  const counts = countBy(inWindow);
  const visible = opts.includeFine ? inWindow : inWindow.filter((c) => c.verdict !== 'verified_fine');
  visible.sort((a, b) => toMs(b.created_at) - toMs(a.created_at));
  return { catches: visible, counts, last_sweep_at: getTeamsRadarLastSweepAt() };
}

export function getTeamsRadarCatch(id: string): TeamsRadarCatch | null {
  const file = path.join(catchesDir(), `${id}.json`);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as TeamsRadarCatch;
  } catch {
    return null;
  }
}

function persistChatExternalId(id: string, externalId: string): void {
  const file = path.join(catchesDir(), `${id}.json`);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw) as TeamsRadarCatch;
    obj.chat_external_id = externalId;
    fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  } catch (err) {
    console.error(`[teams-radar] could not persist chat_external_id for ${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const VERDICT_LABEL: Record<TeamsRadarVerdict, string> = {
  verified_broken: "broken — the probe confirmed it",
  verified_fine: 'fine — the probe found nothing wrong',
  cant_verify: "can't verify — the probe was inconclusive",
  not_applicable: 'chatter/question — never probed, never notified',
};

/** Plain-string context note for the catch's dedicated chat. Zero model
 *  calls — this is written directly as an assistant turn (see
 *  openTeamsRadarChat) so opening a catch's chat never costs a model call;
 *  the receiving JARVIS turn only runs once Kevin actually types something. */
function composeCatchContext(c: TeamsRadarCatch): string {
  const lines: string[] = [
    `📡 This thread is the scope note for Teams Radar catch \`${c.id}\`.`,
    '',
    `Who said it: ${c.author}, ${c.created_at}`,
    `Teams link: ${c.web_url}`,
    '',
    'Quote:',
    `> ${c.quote}`,
    '',
    `Claim: ${c.claim}`,
    `Subject: ${c.subject}`,
    '',
    `Verdict: ${c.verdict} (${VERDICT_LABEL[c.verdict] ?? c.verdict})`,
    `Why: ${c.verdict_why}`,
  ];
  if (c.probe_ran) {
    lines.push('', 'Probe that was run:', `cmd: ${c.probe_ran.cmd}`);
    if (c.probe_ran.stdout_head) lines.push('', 'Evidence:', c.probe_ran.stdout_head.trim());
  }
  if (c.action) {
    lines.push('', `What was done: ${c.action.summary}`);
    if (c.action.kit_path) lines.push(`Kit: ${c.action.kit_path}`);
    if (c.action.kevin_do) lines.push(`**KEVIN-DO: ${c.action.kevin_do}**`);
  }
  lines.push(
    '',
    'This is a read-only scope note, not a live turn — the sweep pipeline never posts or replies in Teams. Ask whatever you need about this specific catch.',
  );
  return lines.join('\n');
}

export interface OpenTeamsRadarChatResult {
  external_id: string;
  link: string;
  created: boolean;
}

/** Find-or-create the dedicated chat for one catch. On first creation the
 *  scope note is written directly as an assistant turn (addTurn), not sent
 *  as a user message — there is nothing for a model to answer yet, so no
 *  model call happens until Kevin actually asks something. */
export function openTeamsRadarChat(id: string): OpenTeamsRadarChatResult | null {
  const c = getTeamsRadarCatch(id);
  if (!c) return null;
  const externalId = `cockpit:teams-catch-${id}`;
  const existing = getConversation(externalId);
  const conv = getOrCreateConversation(externalId);
  if (!existing) {
    const titleClaim = c.claim.length > 60 ? `${c.claim.slice(0, 59)}…` : c.claim;
    renameConversation(conv.id, `Teams catch · ${titleClaim}`.slice(0, 120));
    addTurn(conv.id, 'assistant', composeCatchContext(c));
  }
  if (!c.chat_external_id) persistChatExternalId(id, externalId);
  return {
    external_id: externalId,
    link: `/threads?open=${encodeURIComponent(externalId)}`,
    created: !existing,
  };
}
