# Mutation proof for scripts/alpha-desk-test.mjs: sabotage one rule at a time in the
# BUILT module and require the suite to go red on it. A control run (no mutation)
# must be green first, so a mutant that fails for an unrelated reason is not scored
# as a detection. Asserts the file actually changed before each run.
import subprocess, shutil, sys, os

W = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
T = f'{W}/dist/alpha-desk.js'
BAK = T + '.mutbak'

MUTANTS = [
    ("running no longer beats overdue",
     "if (args.running)\n        return 'running';", "if (false)\n        return 'running';"),
    ("overdue never fires",
     "if (due != null && args.now > due)\n        return 'overdue';",
     "if (false)\n        return 'overdue';"),
    ("reported no longer beats overdue",
     "if (args.reportedAt)\n        return 'reported';", "if (false)\n        return 'reported';"),
    ("unknown verdict kinds are trusted",
     "verdict: VERDICT_KINDS.includes(kind) ? kind : 'pending',", "verdict: kind,"),
    ("brief takes the LAST user turn",
     "ORDER BY id ASC LIMIT 1", "ORDER BY id DESC LIMIT 1"),
    ("final reply takes the FIRST assistant turn",
     """AND content IS NOT NULL AND TRIM(content) <> ''
                    ORDER BY id DESC LIMIT 1""",
     """AND content IS NOT NULL AND TRIM(content) <> ''
                    ORDER BY id ASC LIMIT 1"""),
    ("the orchestrator filter is dropped",
     "WHERE s.origin_conversation_id = ?", "WHERE s.origin_conversation_id = ? OR 1=1"),
    ("a bad verdict file is swallowed",
     "return { verdicts: {}, error: `verdicts.json is not valid JSON (${err.message})` };",
     "return { verdicts: {}, error: null };"),
]

def run():
    r = subprocess.run(['node', 'scripts/alpha-desk-test.mjs'], cwd=W,
                       capture_output=True, text=True, env={**os.environ, 'JARVIS_SIM': '1'})
    return r.returncode, (r.stdout + r.stderr).strip().splitlines()[-1] if (r.stdout+r.stderr).strip() else ''

shutil.copy(T, BAK)
try:
    code, last = run()
    if code != 0:
        print(f"CONTROL RUN IS RED - cannot score mutants. {last}"); sys.exit(1)
    print(f"control: GREEN ({last})")

    caught = 0
    for name, old, new in MUTANTS:
        src = open(BAK).read()
        if src.count(old) != 1:
            print(f"  SKIP (anchor x{src.count(old)}): {name}"); continue
        open(T, 'w').write(src.replace(old, new, 1))
        assert open(T).read() != src, "mutant did not actually change the file"
        code, last = run()
        if code != 0:
            caught += 1; print(f"  caught: {name}")
        else:
            print(f"  MISSED: {name} -> suite still green")
    print(f"\nmutation: {caught}/{len(MUTANTS)} sabotages detected")
    sys.exit(0 if caught == len(MUTANTS) else 1)
finally:
    shutil.move(BAK, T)
