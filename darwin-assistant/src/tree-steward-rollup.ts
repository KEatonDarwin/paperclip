// TREE STEWARD — MORNING ROLLUP (tree-c2d9f80d, node #1725)
//
// A read-only summary of what the Tree Steward did overnight, for one small
// block in the 8am Build Standup (src/briefing.ts). It reads ONLY rows that the
// steward's own effect modules already write — nothing new is stored, no schema
// touched:
//
//   ANSWERS  — Decision Ledger rows (jarvis_decisions). The steward's auto-answer
//              effect (src/tree-steward-act.ts `realStewardEffects.recordDecision`)
//              writes `decided_by: 'jarvis'` with a rationale that ALWAYS begins
//              with the literal "Tree Steward auto-answer —". That prefix is the
//              discriminator. It is reliable because it is a module-written
//              constant, not user/worker text — but note the decision row does
//              NOT carry the node id or tree id as columns (recordDecision maps
//              only question/decidedBy/decision/rationale); only the category and
//              classifier reason are embedded in the rationale text. So an answer
//              line shows category + gist, not node/tree.
//
//   PARKS    — Notification rows (notifications) with `source === 'tree-steward'`,
//              raised by src/tree-steward-card.ts `raiseStewardParkCard`. `source`
//              is a clean discriminator; `meta.sourceId` is the node id and the
//              body's first line carries the tree, so a park line can show
//              #node + tree + gist.
//
// In card-only shadow mode (the default) the steward writes NO decision rows at
// all — every candidate becomes a park card (the auto-answer ones carrying a
// "Would have answered: …" line). So in shadow mode `answered` is empty and the
// parks list carries everything, which is why `mode` is surfaced: the block says
// whether these were real answers or shadow would-haves.
//
// 🔴 NEVER THROWS. briefing.ts's own header warns that a hang or throw in the 8am
// path once killed the morning message for 17 days. Every read here is wrapped in
// try/catch and degrades to empty lists; renderStewardBlock returns '' when there
// is nothing to report, so the standup stays quiet on an empty night.

import { listJarvisDecisions } from './jarvis-decisions.js';
import { listNotifications } from './notifications.js';
import { getSetting } from './conversation-db.js';

export interface StewardRollup {
  answered: string[];
  parked: string[];
  answeredCount: number;
  parkedCount: number;
  mode: string;
}

/** The literal prefix tree-steward-act.ts writes on every auto-answer rationale. */
const ANSWER_RATIONALE_PREFIX = 'Tree Steward auto-answer';
/** Clean source tag tree-steward-card.ts stamps on every park notification. */
const STEWARD_SOURCE = 'tree-steward';
/** Max entries shown per list before collapsing to "… and N more". */
const LIST_CAP = 10;
/** Max chars of a one-line gist. */
const GIST_CAP = 110;

/** Collapse whitespace (incl. newlines) and hard-truncate so a multi-line field
 *  can never inject a newline into a one-line standup entry. */
function oneLine(text: string, max = GIST_CAP): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Resolve the steward mode exactly as src/tree-steward-trigger.ts does:
 *  `steward_mode` === 'live' ? 'live' : 'card_only' (safe default). */
function resolveMode(): string {
  try {
    const raw = (getSetting('steward_mode') ?? '').trim().toLowerCase();
    return raw === 'live' ? 'live' : 'card_only';
  } catch {
    return 'card_only';
  }
}

/** A SQLite datetime('now')-shaped UTC cutoff ("YYYY-MM-DD HH:MM:SS") `hours` ago.
 *  created_at is stored in that exact fixed-width UTC format, so a lexical string
 *  compare against it is correct and needs no DB round-trip. */
function cutoffUtc(hours: number): string {
  const d = new Date(Date.now() - hours * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** Cap a rendered list at LIST_CAP, appending a "… and N more" line on overflow. */
function capList(lines: string[]): string[] {
  if (lines.length <= LIST_CAP) return lines;
  const shown = lines.slice(0, LIST_CAP);
  shown.push(`• … and ${lines.length - LIST_CAP} more`);
  return shown;
}

/** Pull the category out of an auto-answer rationale ("…(category: X); adopted…"). */
function categoryFromRationale(rationale: string | null): string {
  if (!rationale) return 'steward';
  const m = rationale.match(/category:\s*([^)]+)\)/i);
  return m ? m[1].trim() : 'steward';
}

/** Pull "tree <id>" out of a park card body first line ("Node 12, tree abc — …"). */
function treeFromBody(body: string | null): string {
  if (!body) return '';
  const m = body.match(/tree\s+([^\s,—]+)/i);
  return m ? m[1].trim() : '';
}

function collectAnswers(cutoff: string): { lines: string[]; count: number } {
  try {
    const rows = listJarvisDecisions({ decidedBy: 'jarvis', limit: 500 }).filter(
      (r) =>
        typeof r.rationale === 'string' &&
        r.rationale.startsWith(ANSWER_RATIONALE_PREFIX) &&
        r.created_at >= cutoff,
    );
    const lines = rows.map((r) => {
      const cat = categoryFromRationale(r.rationale);
      const gist = oneLine(r.question) || oneLine(r.decision ?? '') || '(no detail)';
      return `• ${cat}: ${gist}`;
    });
    return { lines, count: rows.length };
  } catch (err) {
    console.error('[tree-steward-rollup] answers read failed:', err);
    return { lines: [], count: 0 };
  }
}

function collectParks(cutoff: string): { lines: string[]; count: number } {
  try {
    const rows = listNotifications(500).filter(
      (n) => n.source === STEWARD_SOURCE && n.created_at >= cutoff,
    );
    const lines = rows.map((n) => {
      const nodeId = n.meta?.sourceId ? `#${n.meta.sourceId}` : '#?';
      const tree = treeFromBody(n.body);
      const gist = oneLine((n.title ?? '').replace(/^🧭\s*Tree Steward parked a question:\s*/i, '')) || '(parked)';
      return `• ${nodeId}${tree ? ` ${tree}` : ''} — ${gist}`;
    });
    return { lines, count: rows.length };
  } catch (err) {
    console.error('[tree-steward-rollup] parks read failed:', err);
    return { lines: [], count: 0 };
  }
}

/**
 * Read the two steward sources over the last `hours` (default 16, mirroring
 * briefing.ts's OVERNIGHT_HOURS) and build a rollup. NEVER throws.
 */
export function stewardRollup(hours = 16): StewardRollup {
  const mode = resolveMode();
  const cutoff = cutoffUtc(hours);
  const answers = collectAnswers(cutoff);
  const parks = collectParks(cutoff);
  return {
    answered: capList(answers.lines),
    parked: capList(parks.lines),
    answeredCount: answers.count,
    parkedCount: parks.count,
    mode,
  };
}

/**
 * Render the plain-text standup block. Returns '' when there is nothing to
 * report, so the morning message stays quiet on an empty night.
 */
export function renderStewardBlock(r: StewardRollup): string {
  if (r.answeredCount === 0 && r.parkedCount === 0) return '';
  const lines: string[] = [];
  const modeLabel = r.mode === 'live' ? 'live' : 'shadow (card-only)';
  lines.push(`*Tree Steward* — ${modeLabel}`);
  if (r.answeredCount > 0) {
    lines.push(`Auto-answered (${r.answeredCount}):`);
    lines.push(...r.answered);
  }
  if (r.parkedCount > 0) {
    lines.push(
      r.mode === 'live'
        ? `Parked for your call (${r.parkedCount}):`
        : `Parked for your call — with what it would have answered (${r.parkedCount}):`,
    );
    lines.push(...r.parked);
  }
  return lines.join('\n');
}
