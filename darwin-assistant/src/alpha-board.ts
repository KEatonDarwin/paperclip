// ALPHA BOARD (2026-10-19) — the read surface behind the cockpit /alpha-board page.
//
// Several "Alpha" chats (lanes) coordinate through one shared SQLite board:
// /home/kevin/alpha-board/board.db, an append-only `entries` table the lanes post
// to from the alpha-board CLI. This module answers the one question Kevin has when
// he glances at that: "what lanes are going, what have I decided, and what's held?"
//
// SELF-CONTAINED AND READ-ONLY BY CONSTRUCTION. It opens its OWN read-only handle on
// board.db (NOT jarvis.db, so it does not touch conversation-db), with explicit
// columns, and never throws — a missing/locked board degrades to an empty payload
// with an `error` string the page shows out loud rather than a 500. No model runs.
//
// HONEST STATE (the whole point — `alpha-board lanes` naively counts finished lanes
// as running). A lane is:
//   DONE  — its latest kind='status' body matches \b(DONE|COMPLETE|COMPLETED|
//           SHIPPED|LANDED)\b (case-insensitive).
//   IDLE  — not done, and the lane posted NO entry of any kind in the last 3 hours.
//   LIVE  — anything else (posted inside 3h, not signed off).
// active_claims = kind='claim' rows for that lane that are active=1 and unexpired.
// The lane cap is the alpha_lane.py soft cap (MAX_LANES=5); cap.running counts only
// lanes whose DERIVED state is LIVE, so a board full of finished lanes reads honest.

import Database, { type Database as DatabaseType } from 'better-sqlite3';

/** Where the lanes' shared board lives. Overridable for tests/preview. */
export const BOARD_DB_PATH = process.env.ALPHA_BOARD_DB?.trim() || '/home/kevin/alpha-board/board.db';

/** alpha_lane.py: `MAX_LANES = 5` soft cap. Kept in sync by hand; see that file. */
export const LANE_CAP = 5;

/** How long a chat lane may stay silent before it reads IDLE rather than LIVE. */
const IDLE_AFTER_MS = 3 * 60 * 60 * 1000;

// Sign-off words that flip a lane to DONE. The locked keyword set is
// \b(DONE|COMPLETE|COMPLETED|SHIPPED|LANDED)\b (case-insensitive) — but it is
// applied to the OPENING CLAUSE of the latest status, not the whole body. The
// lanes sign off by LEADING their status with the word ("DONE. …", "LANE
// COMPLETE …"); matching the whole body instead false-flags an active lane whose
// status merely contains "already done" or "lean shipped" mid-sentence — the very
// dishonesty this page exists to kill. See the README for this derivation.
const DONE_RE = /\b(DONE|COMPLETE|COMPLETED|SHIPPED|LANDED)\b/i;

/** The opening clause of a status — up to the first sentence end or ~90 chars —
 *  which is where a lane puts its sign-off word by convention. */
function signoffClause(body: string): string {
  const flat = body.trim();
  const cut = flat.search(/[.!?\n]/);
  const head = cut >= 0 ? flat.slice(0, cut) : flat;
  return head.length > 90 ? head.slice(0, 90) : head;
}

export type LaneState = 'live' | 'idle' | 'done';

export interface LaneRow {
  /** The lane's value IS its chat external_id. */
  lane: string;
  state: LaneState;
  /** Latest kind='status' body + when, or null if the lane never posted a status. */
  last_status: string | null;
  last_status_ts: string | null;
  /** Most recent entry of ANY kind — what "last active" means for IDLE. */
  last_activity_ts: string | null;
  active_claims: number;
  /** /threads?open=<url-encoded lane>, same-origin on purpose (Tailscale-safe). */
  thread_href: string;
}

export interface DecisionRow {
  id: number;
  lane: string;
  ts: string;
  /** Kevin's words, verbatim — the body of a kind='decision' row. */
  body: string;
  /** True when the row was explicitly flagged as Kevin's own words. */
  verbatim_kevin: boolean;
}

export interface ClaimRow {
  id: number;
  lane: string;
  scope: string;
  key: string | null;
  ts: string;
  expires_at: string | null;
  body: string | null;
}

export interface FactRow {
  id: number;
  lane: string;
  scope: string;
  key: string | null;
  ts: string;
  body: string | null;
}

export interface ProposalRow {
  id: number;
  lane: string;
  scope: string;
  key: string | null;
  ts: string;
  body: string | null;
}

export interface AlphaBoardPayload {
  cap: { max: number; running: number };
  counts: { lanes: number; live: number; idle: number; done: number; open_claims: number };
  lanes: LaneRow[];
  decisions: DecisionRow[];
  open_claims: ClaimRow[];
  recent_facts: FactRow[];
  proposals: ProposalRow[];
  board_path: string;
  /** Set when the board can't be read; the page says so rather than showing blanks. */
  error: string | null;
  generated_at: string;
}

function emptyPayload(error: string | null): AlphaBoardPayload {
  return {
    cap: { max: LANE_CAP, running: 0 },
    counts: { lanes: 0, live: 0, idle: 0, done: 0, open_claims: 0 },
    lanes: [],
    decisions: [],
    open_claims: [],
    recent_facts: [],
    proposals: [],
    board_path: BOARD_DB_PATH,
    error,
    generated_at: new Date().toISOString(),
  };
}

/** Board timestamps are ISO-8601 with a Z (e.g. 2026-10-19T13:32:30Z). Parse
 *  defensively — a bare space-separated UTC string still reads as UTC, not local. */
function parseTs(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

interface RawEntry {
  id: number;
  ts: string;
  lane: string;
  kind: string;
  scope: string;
  key: string | null;
  body: string | null;
  expires_at: string | null;
  verbatim_kevin: number;
  active: number;
}

/**
 * The whole board in one read. Never throws: any failure to open or query the
 * board returns an empty payload carrying the error message.
 */
export function buildAlphaBoard(): AlphaBoardPayload {
  const now = Date.now();
  let db: DatabaseType;
  try {
    db = new Database(BOARD_DB_PATH, { readonly: true, fileMustExist: true });
  } catch (err) {
    return emptyPayload(`board not readable at ${BOARD_DB_PATH} (${(err as Error).message})`);
  }

  try {
    // Explicit columns, every row once. The board is a few hundred narrow rows, so a
    // single ordered read and in-memory grouping is cheaper than many prepared reads.
    const all = db
      .prepare(
        `SELECT id, ts, lane, kind, scope, key, body, expires_at, verbatim_kevin, active
           FROM entries
          ORDER BY id DESC`,
      )
      .all() as RawEntry[];

    const claimUnexpired = (e: RawEntry) => {
      if (e.active !== 1) return false;
      const exp = parseTs(e.expires_at);
      return exp == null || exp > now;
    };

    // ── Lanes ────────────────────────────────────────────────────────────────
    // A real lane IS a chat, so its value carries a `prefix:` (cockpit:/slack:…).
    // `curator` and `front-seat` are coordination seats, not chats — excluded from
    // the lane list (front-seat's decisions still surface in the decisions block).
    const laneNames: string[] = [];
    const seen = new Set<string>();
    for (const e of all) {
      if (!e.lane.includes(':')) continue;
      if (seen.has(e.lane)) continue;
      seen.add(e.lane);
      laneNames.push(e.lane);
    }

    const lanes: LaneRow[] = laneNames.map((lane) => {
      const mine = all.filter((e) => e.lane === lane); // already newest-first
      const latestStatus = mine.find((e) => e.kind === 'status') ?? null;
      const lastActivity = mine[0] ?? null; // newest entry of any kind
      const lastActivityMs = parseTs(lastActivity?.ts ?? null);
      const activeClaims = mine.filter((e) => e.kind === 'claim' && claimUnexpired(e)).length;

      let state: LaneState;
      if (latestStatus?.body && DONE_RE.test(signoffClause(latestStatus.body))) {
        state = 'done';
      } else if (lastActivityMs == null || now - lastActivityMs > IDLE_AFTER_MS) {
        state = 'idle';
      } else {
        state = 'live';
      }

      return {
        lane,
        state,
        last_status: latestStatus?.body ?? null,
        last_status_ts: latestStatus?.ts ?? null,
        last_activity_ts: lastActivity?.ts ?? null,
        active_claims: activeClaims,
        thread_href: `/threads?open=${encodeURIComponent(lane)}`,
      };
    });

    // Newest activity first, but a LIVE lane always sorts above IDLE above DONE —
    // the thing Kevin wants at the top is what's moving now.
    const order: Record<LaneState, number> = { live: 0, idle: 1, done: 2 };
    lanes.sort((a, b) => {
      if (order[a.state] !== order[b.state]) return order[a.state] - order[b.state];
      return (parseTs(b.last_activity_ts) ?? 0) - (parseTs(a.last_activity_ts) ?? 0);
    });

    const running = lanes.filter((l) => l.state === 'live').length;

    // ── Kevin's decisions (verbatim), newest first ─────────────────────────────
    const decisions: DecisionRow[] = all
      .filter((e) => e.kind === 'decision' && (e.body ?? '').trim() !== '')
      .slice(0, 40)
      .map((e) => ({
        id: e.id,
        lane: e.lane,
        ts: e.ts,
        body: (e.body ?? '').trim(),
        verbatim_kevin: e.verbatim_kevin === 1,
      }));

    // ── Open claims (held work), recent facts, pending proposals ───────────────
    const open_claims: ClaimRow[] = all
      .filter((e) => e.kind === 'claim' && claimUnexpired(e))
      .map((e) => ({
        id: e.id,
        lane: e.lane,
        scope: e.scope,
        key: e.key,
        ts: e.ts,
        expires_at: e.expires_at,
        body: e.body,
      }));

    const recent_facts: FactRow[] = all
      .filter((e) => e.kind === 'fact' && e.active === 1)
      .slice(0, 20)
      .map((e) => ({ id: e.id, lane: e.lane, scope: e.scope, key: e.key, ts: e.ts, body: e.body }));

    const proposals: ProposalRow[] = all
      .filter((e) => e.kind === 'proposal' && e.active === 1)
      .slice(0, 20)
      .map((e) => ({ id: e.id, lane: e.lane, scope: e.scope, key: e.key, ts: e.ts, body: e.body }));

    return {
      cap: { max: LANE_CAP, running },
      counts: {
        lanes: lanes.length,
        live: running,
        idle: lanes.filter((l) => l.state === 'idle').length,
        done: lanes.filter((l) => l.state === 'done').length,
        open_claims: open_claims.length,
      },
      lanes,
      decisions,
      open_claims,
      recent_facts,
      proposals,
      board_path: BOARD_DB_PATH,
      error: null,
      generated_at: new Date().toISOString(),
    };
  } catch (err) {
    return emptyPayload(`board query failed (${(err as Error).message})`);
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}
