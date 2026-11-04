/**
 * MIKE RADAR — the in-process scheduler.
 *
 * NO NEW SYSTEMD UNITS, deliberately (node spec). Both passes live inside
 * jarvis.service next to the health monitor and the monitor scheduler:
 *
 *   - INGEST: hourly at :20 CT. The Lovable Watcher fires at :00 and Stub Radar
 *     at ~:12, so :20 always reads a settled archive. Pure file → SQLite, no
 *     model, no network — cheap enough that a missed hour is a non-event (the
 *     per-file high-water mark makes the next sweep catch up).
 *   - REPORTS: daily at 23:40 America/Chicago, serially, one claude process at
 *     a time, so the governor never sees a burst.
 *
 * Both lanes are gated by the work switch (`mike_ingest` / `mike_report`), so
 * Kevin's STOP-ALL covers them, and both are wrapped so a throw can never take
 * the service down. MIKE_RADAR_DRIVER=0 disables the whole thing.
 */

import { laneStopped } from './work-switch.js';
import { runMikeIngest } from './mike-radar-ingest.js';
import { runMikeReportPass } from './mike-radar-report.js';
import { mikeReportDate } from './mike-radar.js';

/** Ingest fires at this minute past the hour (CT == UTC in minutes, so a plain
 *  minute-of-hour comparison is correct regardless of timezone). */
const INGEST_MINUTE = 20;
/** Report pass fires at 23:40 America/Chicago. */
const REPORT_HOUR_CT = 23;
const REPORT_MINUTE_CT = 40;
/** The tick that decides whether either of the above is due. */
const TICK_MS = 60_000;

let started = false;
let ingestInFlight = false;
let reportInFlight = false;
let lastIngestSlot: string | null = null;
let lastReportDate: string | null = null;

function ctHourMinute(now = new Date()): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  // Intl renders midnight as hour 24 in some ICU builds.
  return { hour: get('hour') % 24, minute: get('minute') };
}

/** `YYYY-MM-DDTHH` — the slot an hourly pass may run at most once in. */
function hourSlot(now = new Date()): string {
  return now.toISOString().slice(0, 13);
}

export function mikeIngestDue(now = new Date(), lastSlot: string | null = lastIngestSlot): boolean {
  if (now.getUTCMinutes() < INGEST_MINUTE) return false;
  return hourSlot(now) !== lastSlot;
}

export function mikeReportDue(now = new Date(), lastDate: string | null = lastReportDate): boolean {
  const { hour, minute } = ctHourMinute(now);
  if (hour !== REPORT_HOUR_CT || minute < REPORT_MINUTE_CT) return false;
  return mikeReportDate(now) !== lastDate;
}

async function tick(): Promise<void> {
  const now = new Date();

  if (!ingestInFlight && mikeIngestDue(now) && !laneStopped('mike_ingest')) {
    ingestInFlight = true;
    lastIngestSlot = hourSlot(now);
    try {
      runMikeIngest();
    } catch (err) {
      console.error('[mike-radar] ingest sweep threw:', err);
    } finally {
      ingestInFlight = false;
    }
  }

  if (!reportInFlight && mikeReportDue(now) && !laneStopped('mike_report')) {
    reportInFlight = true;
    const date = mikeReportDate(now);
    lastReportDate = date;
    try {
      await runMikeReportPass(date);
    } catch (err) {
      console.error('[mike-radar] report pass threw:', err);
    } finally {
      reportInFlight = false;
    }
  }
}

export function startMikeRadarDriver(): void {
  if (started) return;
  if (process.env['MIKE_RADAR_DRIVER'] === '0') {
    console.log('[mike-radar] driver disabled (MIKE_RADAR_DRIVER=0)');
    return;
  }
  started = true;

  // Catch-up sweep at boot: a restart between :20 marks would otherwise skip an
  // hour. Cheap (file → SQLite, seconds) and idempotent, so there is no reason
  // to wait for the next slot.
  queueMicrotask(() => {
    if (laneStopped('mike_ingest')) return;
    try {
      runMikeIngest();
      lastIngestSlot = hourSlot(new Date());
    } catch (err) {
      console.error('[mike-radar] boot ingest failed:', err);
    }
  });

  setInterval(() => void tick(), TICK_MS).unref?.();
  console.log(`[mike-radar] driver started · ingest hourly at :${INGEST_MINUTE} · reports ${REPORT_HOUR_CT}:${REPORT_MINUTE_CT} CT`);
}

/** Test seam — resets the once-per-slot memo. */
export function _resetMikeRadarDriverState(): void {
  lastIngestSlot = null;
  lastReportDate = null;
  ingestInFlight = false;
  reportInFlight = false;
}
