# Mutation proof for the spawn-chat per-hour LIMIT DIAL (test 9 in
# scripts/spawn-chat-check.mjs). Same discipline as alpha-desk-mutate.py: a green
# control run first, the file must actually change, and every sabotage must turn
# the suite red.
#
# The dial's whole promise is "change it and the next call obeys, with no restart".
# A test that only ever reads the getter would pass even if the GATE still used a
# baked-in number, so the mutants deliberately attack the gate and the fallbacks,
# not just the arithmetic.
import subprocess, shutil, sys, os

W = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
T = f'{W}/dist/tools/spawn-chat-tool.js'
BAK = T + '.mutbak'
DB = '/tmp/spawn-limit-mutate/check.db'

MUTANTS = [
    ("the gate ignores the dial and uses the default",
     "if ((S().countRecent.get(origin.id)?.n ?? 0) >= limit) {",
     "if ((S().countRecent.get(origin.id)?.n ?? 0) >= SPAWN_LIMIT_DEFAULT) {"),
    ("the limit is read ONCE instead of at call time",
     "const limit = spawnLimitPerHour();", "const limit = SPAWN_LIMIT_DEFAULT;"),
    ("the default is the old hard-coded 5",
     "export const SPAWN_LIMIT_DEFAULT = 30;", "export const SPAWN_LIMIT_DEFAULT = 5;"),
    ("an unset dial falls back to 0, stopping Alpha delegating entirely",
     "    const raw = getSetting(SPAWN_LIMIT_SETTING_KEY);\n    if (raw === null)\n        return SPAWN_LIMIT_DEFAULT;",
     "    const raw = getSetting(SPAWN_LIMIT_SETTING_KEY);\n    if (raw === null)\n        return 0;"),
    ("a non-numeric dial value becomes 0 instead of the default",
     "    if (!Number.isFinite(n))\n        return SPAWN_LIMIT_DEFAULT;",
     "    if (!Number.isFinite(n))\n        return 0;"),
    ("an empty dial value is parsed as a number (Number('') is 0)",
     "    const text = String(raw).trim();\n    if (!text)\n        return SPAWN_LIMIT_DEFAULT;",
     "    const text = String(raw).trim();\n    if (false)\n        return SPAWN_LIMIT_DEFAULT;"),
    ("the clamp is removed, so a typo of 99999 is honoured",
     "return Math.min(SPAWN_LIMIT_MAX, Math.max(SPAWN_LIMIT_MIN, Math.floor(n)));",
     "return Math.floor(n);"),
    ("the lower clamp is removed, so a dial of 0 blocks every spawn",
     "return Math.min(SPAWN_LIMIT_MAX, Math.max(SPAWN_LIMIT_MIN, Math.floor(n)));",
     "return Math.min(SPAWN_LIMIT_MAX, Math.floor(n));"),
    ("the refusal quotes a baked-in number instead of the live limit",
     "message: `max ${limit} spawns per chat per hour",
     "message: `max 5 spawns per chat per hour"),
]


def run():
    env = {**os.environ, 'JARVIS_DB_PATH': DB, 'JARVIS_SIM': '1'}
    shutil.rmtree(os.path.dirname(DB), ignore_errors=True)
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    r = subprocess.run(['node', 'scripts/spawn-chat-check.mjs'], cwd=W,
                       capture_output=True, text=True, env=env)
    out = (r.stdout + r.stderr).strip()
    return r.returncode, out.splitlines()[-1] if out else ''


shutil.copy(T, BAK)
try:
    code, last = run()
    if code != 0:
        print(f"CONTROL RUN IS RED - cannot score mutants. {last}")
        sys.exit(1)
    print(f"control: GREEN ({last})\n")

    caught = 0
    skipped = 0
    for name, old, new in MUTANTS:
        src = open(BAK).read()
        if src.count(old) != 1:
            print(f"  SKIP (anchor x{src.count(old)}): {name}")
            skipped += 1
            continue
        open(T, 'w').write(src.replace(old, new, 1))
        assert open(T).read() != src, "mutant did not actually change the file"
        code, last = run()
        shutil.copy(BAK, T)
        if code != 0:
            caught += 1
            print(f"  caught: {name}")
        else:
            print(f"  MISSED: {name} -> suite still green")
    print(f"\nmutation: {caught}/{len(MUTANTS)} sabotages detected"
          + (f" ({skipped} skipped - anchor drift)" if skipped else ""))
    sys.exit(0 if caught == len(MUTANTS) else 1)
finally:
    shutil.move(BAK, T)
