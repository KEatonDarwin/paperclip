# Mutation proof for scripts/alpha-desk-test.mjs: sabotage one rule at a time in the
# BUILT module and require the suite to go red on it. A control run (no mutation)
# must be green first, so a mutant that fails for an unrelated reason is not scored
# as a detection. Asserts the file actually changed before each run.
#
# Mutants name the file they target, because the rules now live in two modules: the
# desk roll-up and the price table. A sabotage of the price table that the suite
# does not notice is the worst failure available here — it puts a wrong dollar
# figure on Kevin's screen with nothing on the page to say it is wrong.
import subprocess, shutil, sys, os

W = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESK = f'{W}/dist/alpha-desk.js'
PRICE = f'{W}/dist/alpha-desk-pricing.js'

MUTANTS = [
    # ── the state machine ────────────────────────────────────────────────────
    (DESK, "running no longer beats overdue",
     "if (args.running)\n        return 'running';", "if (false)\n        return 'running';"),
    (DESK, "overdue never fires",
     "if (due != null && args.now > due)\n        return 'overdue';",
     "if (false)\n        return 'overdue';"),
    (DESK, "reported no longer beats overdue",
     "if (args.reportedAt)\n        return 'reported';", "if (false)\n        return 'reported';"),
    (DESK, "unknown verdict kinds are trusted",
     "verdict: VERDICT_KINDS.includes(kind) ? kind : 'pending',", "verdict: kind,"),
    (DESK, "brief takes the LAST user turn",
     "ORDER BY id ASC LIMIT 1", "ORDER BY id DESC LIMIT 1"),
    (DESK, "final reply takes the FIRST assistant turn",
     """AND content IS NOT NULL AND TRIM(content) <> ''
                    ORDER BY id DESC LIMIT 1""",
     """AND content IS NOT NULL AND TRIM(content) <> ''
                    ORDER BY id ASC LIMIT 1"""),
    (DESK, "the orchestrator filter is dropped",
     "WHERE s.origin_conversation_id = ?\n          ORDER BY s.id DESC",
     "WHERE s.origin_conversation_id = ? OR 1=1\n          ORDER BY s.id DESC"),
    (DESK, "a bad verdict file is swallowed",
     "return { verdicts: {}, error: `verdicts.json is not valid JSON (${err.message})` };",
     "return { verdicts: {}, error: null };"),

    # ── the money: each of these would put a wrong number on the page ────────
    (PRICE, "cache reads are priced as fresh INPUT (the bug the meter exists to avoid)",
     "t.cache_read_tokens * p.cache_read", "t.cache_read_tokens * p.input"),
    (PRICE, "cache writes are priced at the 1-hour rate in the headline figure",
     "usd: base + (t.cache_write_tokens * p.cache_write_5m) / 1_000_000,",
     "usd: base + (t.cache_write_tokens * p.cache_write_1h) / 1_000_000,"),
    (PRICE, "an unknown model silently costs $0 instead of reading as unpriced",
     "export function costOf(model, t, longPrompt) {\n    const p = priceFor(model, t, longPrompt);\n    if (!p)\n        return null;",
     "export function costOf(model, t, longPrompt) {\n    const p = priceFor(model, t, longPrompt);\n    if (!p)\n        return { usd: 0, usd_max: 0 };"),
    (PRICE, "the [1m] long-context flag is not stripped, so those turns go unpriced",
     "s = s.replace(/\\[[^\\]]*\\]/g, '');", "s = s.replace(/NEVERMATCHES/g, '');"),
    (PRICE, "a dated snapshot model id is not normalised",
     "s = s.replace(/-\\d{8}$/, '');", "s = s.replace(/-NEVERMATCHES$/, '');"),
    (PRICE, "haiku-5-5's long-prompt tier never fires",
     "return (longPrompt ?? isLongPrompt(t)) ? HAIKU_55_LONG : MODEL_PRICES['haiku-5-5'];",
     "return MODEL_PRICES['haiku-5-5'];"),
    (PRICE, "the haiku prompt tier ignores cache reads (the page says it must not)",
     "return t.input_tokens + t.cache_read_tokens + t.cache_write_tokens > HAIKU_LONG_PROMPT_TOKENS;",
     "return t.input_tokens > HAIKU_LONG_PROMPT_TOKENS;"),
    (PRICE, "opus-5 is priced at opus-5.5's cheaper rates",
     "'opus-5': { label: 'Opus 5', input: 5, output: 25, cache_write_5m: 6.25, cache_write_1h: 10, cache_read: 0.50 },",
     "'opus-5': { label: 'Opus 5', input: 4, output: 20, cache_write_5m: 5, cache_write_1h: 8, cache_read: 0.20 },"),

    # ── the windows and the split ────────────────────────────────────────────
    (DESK, "the last hour is a calendar day",
     "const hourAgo = now - 3_600_000;", "const hourAgo = now - 86_400_000;"),
    (DESK, "'today' reverts to the UTC day",
     "export function ctDay(ms) {\n    return CT_DAY_FMT.format(new Date(ms));",
     "export function ctDay(ms) {\n    return new Date(ms).toISOString().slice(0, 10);"),
    (DESK, "the descendant walk stops at the first level (grandchildren go uncounted)",
     "out.push(id);\n            queue.push(id);", "out.push(id);"),
    (DESK, "Alpha's own chat is counted twice, in alpha AND in spawned",
     "for (const id of descendantConversations(origin.id))\n        spawnedRows.push(...tokenRowsFor(id));",
     "for (const id of [origin.id, ...descendantConversations(origin.id)])\n        spawnedRows.push(...tokenRowsFor(id));"),
    (DESK, "a row reports the whole desk's tokens instead of its own",
     "tokens: totalsOf(tokenRowsFor(s.child_conversation_id)),",
     "tokens: totalsOf(tokenRowsFor(origin.id)),"),
]


def run():
    r = subprocess.run(['node', 'scripts/alpha-desk-test.mjs'], cwd=W,
                       capture_output=True, text=True, env={**os.environ, 'JARVIS_SIM': '1'})
    out = (r.stdout + r.stderr).strip()
    return r.returncode, out.splitlines()[-1] if out else ''


targets = sorted({m[0] for m in MUTANTS})
for t in targets:
    shutil.copy(t, t + '.mutbak')
try:
    code, last = run()
    if code != 0:
        print(f"CONTROL RUN IS RED - cannot score mutants. {last}")
        sys.exit(1)
    print(f"control: GREEN ({last})\n")

    caught = 0
    skipped = 0
    for target, name, old, new in MUTANTS:
        bak = target + '.mutbak'
        src = open(bak).read()
        if src.count(old) != 1:
            print(f"  SKIP (anchor x{src.count(old)}): {name}")
            skipped += 1
            continue
        open(target, 'w').write(src.replace(old, new, 1))
        assert open(target).read() != src, "mutant did not actually change the file"
        code, last = run()
        shutil.copy(bak, target)          # restore before the next mutant
        if code != 0:
            caught += 1
            print(f"  caught: {name}")
        else:
            print(f"  MISSED: {name} -> suite still green")
    print(f"\nmutation: {caught}/{len(MUTANTS)} sabotages detected"
          + (f" ({skipped} skipped - anchor drift)" if skipped else ""))
    sys.exit(0 if caught == len(MUTANTS) else 1)
finally:
    for t in targets:
        shutil.move(t + '.mutbak', t)
