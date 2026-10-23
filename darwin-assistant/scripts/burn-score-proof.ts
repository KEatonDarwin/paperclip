// Standalone proof for the burn-rate account score (CONTRACT §4.7).
// Run: npx tsx scripts/burn-score-proof.ts   (pure function, no DB, no network)
import { claudeBurnScore } from '../src/throttle.js';
import type { AccountUsage } from '../src/claude-accounts.js';

const NOW = Date.parse('2026-10-08T21:00:00Z');
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

function u(p: Partial<AccountUsage>): AccountUsage {
  return {
    five_hour: null,
    weekly: null,
    stale: false,
    locked_reason: null,
    five_hour_resets_at: null,
    weekly_resets_at: null,
    ...p,
  };
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}  ${detail}`);
  }
}

// 1. Kevin's example: both 50% on 5h, weekly non-binding; the one resetting in
//    15 min must win decisively over the one resetting in 3h.
{
  const soon = claudeBurnScore(u({ five_hour: 50, five_hour_resets_at: inHours(0.25) }), 90, 100, NOW)!;
  const later = claudeBurnScore(u({ five_hour: 50, five_hour_resets_at: inHours(3) }), 90, 100, NOW)!;
  check('15-min window beats 3-hour window at equal 5h usage', soon > later, `${soon} vs ${later}`);
  check('and it is a big margin (>5x)', soon > later * 5, `${soon} vs ${later}`);
}

// 2. The real A-vs-B bug: A fresh on 5h (0%) but weekly maxed (98%, resets in
//    >1 day); B light on both. New formula must pick B; old "lowest 5h" picked A.
{
  const a = claudeBurnScore(
    u({ five_hour: 0, five_hour_resets_at: inHours(8), weekly: 98, weekly_resets_at: inHours(33) }),
    90, 100, NOW,
  )!;
  const b = claudeBurnScore(
    u({ five_hour: 9, five_hour_resets_at: inHours(9), weekly: 3, weekly_resets_at: inHours(168) }),
    90, 100, NOW,
  )!;
  check('B (light) beats A (weekly-maxed) despite A 5h=0%', b > a, `A=${a} B=${b}`);
  check("A's score is dragged near zero by its spent weekly", a < 0.2, `A=${a}`);
}

// 3. Non-binding / unscorable windows.
{
  check('both windows unknown -> null (caller falls back to least-used)',
    claudeBurnScore(u({}), 90, 100, NOW) === null);
  const only5 = claudeBurnScore(u({ five_hour: 10, five_hour_resets_at: inHours(4) }), 90, 100, NOW);
  check('weekly unknown -> score from 5h alone, not null', only5 != null && only5 > 0, `${only5}`);
}

// 4. Reset in the past (clock drift / already reset) uses the 5-min floor, not a
//    negative or infinite rate -> reads as high urgency, finite.
{
  const past = claudeBurnScore(u({ five_hour: 50, five_hour_resets_at: inHours(-1) }), 90, 100, NOW)!;
  check('overdue reset is finite and high', Number.isFinite(past) && past > 100, `${past}`);
}

// 5. Headroom clamped at 0 when usage is over the ceiling (never negative).
{
  const over = claudeBurnScore(u({ five_hour: 95, five_hour_resets_at: inHours(2) }), 90, 100, NOW)!;
  check('usage over ceiling -> score 0, never negative', over === 0, `${over}`);
}

console.log(`\nburn-score-proof: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
