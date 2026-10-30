// tree-steward-demo.ts — a model-free, re-runnable demo harness for the Tree
// Steward's pure classifier.
//
// This is a PLAIN SCRIPT, not a test suite: run it with
//   npx tsx tools/tree-steward-demo.ts          (human-readable table)
//   npx tsx tools/tree-steward-demo.ts --json    (raw decisions, for #384)
//
// It reads hand-written cases from tools/fixtures/tree-steward-cases.json,
// calls classifyBlockedQuestion on each, and prints one line per case plus a
// summary. It never touches a database, a network, or a model — every fixture
// is written by hand from the shapes a real worker wall produces. It always
// exits 0 (a demo, never a gate); a MISMATCH is reported, not thrown.

import { readFileSync } from 'node:fs';
import {
  classifyBlockedQuestion,
  type StewardInput,
  type StewardDecision,
} from '../src/tree-steward.js';

interface Case {
  name: string;
  expect: StewardDecision['action'];
  expect_category: string;
  expect_confidence?: StewardDecision['confidence'];
  why: string;
  input: StewardInput;
}

const FIXTURES_URL = new URL('./fixtures/tree-steward-cases.json', import.meta.url);

function loadCases(): Case[] {
  const raw = readFileSync(FIXTURES_URL, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('fixtures file must contain a JSON array of cases');
  }
  return parsed as Case[];
}

function oneLine(s: string | null, max = 80): string {
  const flat = (s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) : flat;
}

function main(): void {
  const jsonMode = process.argv.includes('--json');
  const cases = loadCases();

  if (jsonMode) {
    // Raw decisions, so #384 can capture evidence programmatically.
    const rows = cases.map((c) => ({
      name: c.name,
      expect: c.expect,
      expect_category: c.expect_category,
      expect_confidence: c.expect_confidence ?? null,
      decision: classifyBlockedQuestion(c.input),
    }));
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    process.exit(0);
  }

  let matched = 0;
  let mismatched = 0;

  for (const c of cases) {
    const d = classifyBlockedQuestion(c.input);
    // A case matches on the two load-bearing fields the spec compares:
    // the action and the rule category. (Confidence is printed and, when the
    // fixture pins expect_confidence, also required to match.)
    const actionOk = d.action === c.expect;
    const categoryOk = d.category === c.expect_category;
    const confOk = c.expect_confidence == null || d.confidence === c.expect_confidence;
    const ok = actionOk && categoryOk && confOk;
    if (ok) matched++;
    else mismatched++;

    const tag = ok ? 'PASS    ' : 'MISMATCH';
    const expectConf = c.expect_confidence ? `/${c.expect_confidence}` : '';
    process.stdout.write(
      `${tag}  ${c.name}  expected=${c.expect}/${c.expect_category}${expectConf}  ` +
        `got=${d.action}/${d.category}  conf=${d.confidence}  answer=${oneLine(d.answer)}\n`,
    );
  }

  process.stdout.write(
    `\n${cases.length} cases, ${matched} matched, ${mismatched} mismatched\n`,
  );
  // Always exit 0 — this is a demo harness, not a CI gate.
  process.exit(0);
}

main();
