import { getNotepadLine, markLineActed, type NotepadLine } from './notepad.js';
import { getNotepadMarker, setNotepadMarkerActionRef, type NotepadMarker, type NotepadMarkerKind } from './notepad-markers.js';
import { buildTopicDossier, type TopicDossier, type BuildDossierOptions } from './notepad-dossier.js';
import { getConversation, getOrCreateConversation, renameConversation } from './conversation-db.js';
import { processMessage } from './agent.js';

// Node #869 — "the handoff prompt is written by JARVIS, not by the line —
// clicking a marker opens a thread that is already working." This is the
// server side of that: given a line that already has a marker (node #849/
// #854), find-or-create the ONE thread that line's handoff always opens, and
// on the very first open, seed it with a prompt composed from node #107's
// topic dossier (src/notepad-dossier.ts) so the turn starts working
// immediately instead of asking Kevin what he meant.
//
// This module owns exactly two things: the prompt composer
// (buildNotepadHandoffPrompt) and the find-or-create-and-seed orchestration
// (openNotepadHandoff). It does not decide what a marker says (notepad-moves.ts)
// and it does not own the marker store (notepad-markers.ts) — it only reads
// from both and, on first open, writes the thread link back onto them
// (action_ref + the per-line ledger) so the marker reconciles instead of
// firing again (notepad.ts's unscannedLines() skips an 'acted' line whose
// text hasn't changed).

const MARKER_KIND_LABEL: Record<NotepadMarkerKind, string> = {
  take_it: 'JARVIS proposed taking this on',
  question: 'JARVIS flagged this as needing a decision from Kevin',
  already_done: 'JARVIS believes this is already done',
  context: 'JARVIS flagged this line for context/awareness',
};

/**
 * Compose the seed prompt for a line's handoff thread. Carries the line
 * verbatim, the marker's move kind + reason, and the dossier's own rendered
 * text (already the honest, evidence-only summary node #107 built — reused
 * here, not rebuilt: it already says "JARVIS has no context on this line
 * yet" when confidence is 'none', so this composer never has to invent that
 * honesty itself). Always ends with an instruction to start working now,
 * never to ask Kevin what he meant.
 */
export function buildNotepadHandoffPrompt(
  line: Pick<NotepadLine, 'text'>,
  marker: Pick<NotepadMarker, 'kind' | 'reason'>,
  dossier: TopicDossier,
): string {
  return [
    "Kevin clicked a marker on this notepad line — this chat exists to act on it, not to ask him what he meant.",
    '',
    `The line: ${JSON.stringify(line.text)}`,
    `${MARKER_KIND_LABEL[marker.kind] ?? marker.kind} — ${marker.reason}`,
    '',
    dossier.rendered,
    '',
    'Start working on this now, using whatever context is above (including its honest absence, if there is none). Only ask Kevin something if you are genuinely blocked without him.',
  ].join('\n');
}

/** Deterministic per-line thread ext — line_id is stable across edits
 *  (node #60), so this never mints a fresh thread for the same line twice,
 *  and never depends on the current date. */
export function notepadHandoffThreadExt(lineId: number): string {
  return `cockpit:notepad-line-${lineId}`;
}

export interface OpenNotepadHandoffResult {
  thread_ext: string;
  created: boolean;
  /** The composed prompt, only when this call is the one that just seeded
   *  it (created:true) — null on a reused thread, since nothing was (re-)
   *  sent this time. Mirrors the seed_text:null-on-reuse convention every
   *  other find-or-create-thread route in this file already uses (smart-todos
   *  open-chat, workbench open-chat, goals getOrCreateNodeThread). */
  seeded_prompt: string | null;
}

export interface OpenNotepadHandoffOptions {
  /** Forwarded to buildTopicDossier — the injection seam a sim/check uses to
   *  stub its one model call, exactly as notepad-dossier-check.mjs already does. */
  dossierOpts?: BuildDossierOptions;
  /** Injection seam for a sim/check to stub the actual turn dispatch instead
   *  of touching agent.js's real processMessage. Defaults to processMessage
   *  itself, which is already sim-guarded (src/sim-guard.ts) — under a
   *  scratch JARVIS_DB_PATH it no-ops instead of spawning a model, so even
   *  the unstubbed default is safe to exercise in a route check. */
  postMessage?: (text: string, externalId: string, messageId?: string) => Promise<string>;
}

/**
 * Find-or-create the line's handoff thread. On first open, builds the topic
 * dossier, composes the seed prompt, posts it so the turn actually
 * dispatches, and records the thread ext as the line's marker action_ref +
 * per-line ledger action (so it reconciles instead of firing again). A
 * second call for the same line_id is a pure read: same thread_ext,
 * created:false, no second seed message.
 *
 * The existence check + claim (getConversation, then unconditionally
 * getOrCreateConversation) happens back-to-back with no `await` between them
 * — both are synchronous better-sqlite3 calls — so two concurrent opens for
 * the same line can never both see "not created" and both seed it; the first
 * to reach getOrCreateConversation claims the row, and every call after that
 * (including one racing in in the same tick) observes `existing` truthy.
 *
 * Throws if the line has no marker, or the line itself doesn't exist — the
 * caller (the route) is expected to have already turned that into a 404,
 * same no-silent-no-op discipline as reconcileNotepadMarker/dismissNotepadMarker.
 */
export async function openNotepadHandoff(
  lineId: number,
  opts: OpenNotepadHandoffOptions = {},
): Promise<OpenNotepadHandoffResult> {
  const marker = getNotepadMarker(lineId);
  if (!marker) throw new Error(`no notepad marker on line ${lineId}`);
  const line = getNotepadLine(lineId);
  if (!line) throw new Error(`notepad line ${lineId} not found`);

  const externalId = notepadHandoffThreadExt(lineId);
  const existing = getConversation(externalId);
  const conv = getOrCreateConversation(externalId);
  const created = !existing;

  if (!created) {
    return { thread_ext: externalId, created: false, seeded_prompt: null };
  }

  renameConversation(conv.id, line.text.slice(0, 120));

  const dossier = await buildTopicDossier({ line_id: lineId }, opts.dossierOpts);
  const prompt = buildNotepadHandoffPrompt(line, marker, dossier);

  setNotepadMarkerActionRef(lineId, externalId);
  markLineActed(lineId, externalId);

  const post = opts.postMessage ?? processMessage;
  post(prompt, externalId, `turn:${conv.id}:0`).catch((err: unknown) => {
    console.error(`[notepad-handoff] seed post failed for line ${lineId}`, err);
  });

  return { thread_ext: externalId, created: true, seeded_prompt: prompt };
}
