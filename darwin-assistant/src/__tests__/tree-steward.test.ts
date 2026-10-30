// ===========================================================================
//  tree-steward.test.ts  —  WRITTEN BY A WORKER, DELIBERATELY NEVER EXECUTED.
//
//  Per Kevin's standing order (2026-10-28): unit tests for any of our setups
//  are NEVER run by a worker or by JARVIS. This file was authored on
//  2026-10-29 and left un-run on purpose. Only Kevin runs it, from his shell:
//
//      cd /home/kevin/paperclip-worktrees/tree-steward/darwin-assistant \
//        && npx vitest run src/__tests__/tree-steward.test.ts
//
//  NOTE ON THE RUNNER: this repo has no test framework installed and no `test`
//  script in package.json (its other "tests" are hand-rolled tsx/node scripts
//  under scripts/). This file is written in vitest style per the task spec;
//  `npx vitest` will fetch vitest on first run (or `npm i -D vitest` once).
//  Test files are excluded from the app's tsconfig, so `npx tsc --noEmit` and
//  `npm run build` never try to compile this (and never choke on the missing
//  'vitest' types) — vitest type-checks and runs it with its own config.
//
//  A PASS proves: the pure classifier maps every documented case to the right
//  action + category + confidence, adopts (never invents) the worker's
//  recommendation, and the module source carries no I/O.
//  A PASS does NOT prove: that the engine wiring around it (#381/#384) acts on
//  the decision correctly, nor anything about live data — this file only
//  exercises the pure function.
// ===========================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  classifyBlockedQuestion,
  type StewardInput,
  type StewardDecision,
} from '../tree-steward.js';

interface Case {
  name: string;
  expect: StewardDecision['action'];
  expect_category: string;
  expect_confidence?: StewardDecision['confidence'];
  why: string;
  input: StewardInput;
}

// Drive every case from the SHARED fixtures so the fixture file stays the
// single source of truth for both the demo and these tests.
const FIXTURES_URL = new URL('../../tools/fixtures/tree-steward-cases.json', import.meta.url);
const CASES: Case[] = JSON.parse(readFileSync(FIXTURES_URL, 'utf8')) as Case[];

// Every branch the decision table documents must be exercised by a fixture.
const EXPECTED_CATEGORIES = [
  'not_a_question',
  'empty_question',
  'escalation_production',
  'escalation_destructive',
  'escalation_merge_main',
  'escalation_external',
  'escalation_money',
  'fence_test_or_db',
  'cap_reached',
  'has_recommendation',
  'no_recommendation',
] as const;

describe('classifyBlockedQuestion — fixture-driven decision table', () => {
  it('loads the shared fixtures', () => {
    expect(Array.isArray(CASES)).toBe(true);
    expect(CASES.length).toBeGreaterThan(0);
  });

  for (const c of CASES) {
    it(`${c.name} → ${c.expect}/${c.expect_category}`, () => {
      const d = classifyBlockedQuestion(c.input);
      expect(d.action).toBe(c.expect);
      expect(d.category).toBe(c.expect_category);
      if (c.expect_confidence != null) {
        expect(d.confidence).toBe(c.expect_confidence);
      }
      // park_card / noop must never hand back an answer; auto_answer always must.
      if (d.action === 'auto_answer') {
        expect(typeof d.answer).toBe('string');
        expect((d.answer ?? '').length).toBeGreaterThan(0);
      } else {
        expect(d.answer).toBeNull();
      }
      // reason is always set, naming the rule that fired.
      expect(typeof d.reason).toBe('string');
      expect(d.reason.length).toBeGreaterThan(0);
    });
  }

  it('the fixtures exercise every documented decision branch', () => {
    const seen = new Set(CASES.map((c) => c.expect_category));
    for (const cat of EXPECTED_CATEGORIES) {
      expect(seen.has(cat)).toBe(true);
    }
  });
});

describe('auto_answer adopts the worker recommendation — it does not invent one', () => {
  const autoCases = CASES.filter((c) => c.expect === 'auto_answer');

  it('has at least one auto_answer fixture to check', () => {
    expect(autoCases.length).toBeGreaterThan(0);
  });

  for (const c of autoCases) {
    it(`${c.name}: answer contains the adopted recommendation, and that text came from the worker`, () => {
      const d = classifyBlockedQuestion(c.input);
      expect(d.action).toBe('auto_answer');
      // The decision must carry the recommendation it adopted...
      expect(d.recommendation).not.toBeNull();
      const rec = d.recommendation as string;
      expect(rec.length).toBeGreaterThan(0);
      // ...the answer handed to the node must CONTAIN that recommendation...
      expect(d.answer).not.toBeNull();
      expect((d.answer as string).includes(rec)).toBe(true);
      // ...and the recommendation must be text the WORKER actually wrote
      // (adoption, not invention): it is a substring of the question+result
      // haystack the classifier read, exactly as the classifier builds it.
      const haystack = `${c.input.question ?? ''}\n${c.input.result ?? ''}`;
      expect(haystack.includes(rec)).toBe(true);
    });
  }
});

describe('the classifier module is pure — its source carries no I/O', () => {
  // Read the actual source of the module under test. This fs read lives inside
  // the test (which we never run); Kevin runs it — reading a source file in a
  // test is ordinary.
  const SOURCE_URL = new URL('../tree-steward.ts', import.meta.url);
  const rawSource = readFileSync(SOURCE_URL, 'utf8');

  // Strip comments first: the module's own header DOCUMENTS the I/O tokens it
  // forbids ("no `fs`, `fetch(`, `process.env`, `better-sqlite3` ..."), so a
  // naive substring scan would false-positive on the documentation. We assert
  // on CODE, not prose.
  const code = rawSource
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (leave http:// etc. alone)

  it('imports nothing (no fs / better-sqlite3 / require)', () => {
    expect(/from\s+['"](node:)?fs['"]/.test(code)).toBe(false);
    expect(/better-sqlite3/.test(code)).toBe(false);
    expect(/\brequire\s*\(/.test(code)).toBe(false);
    // The module has no import statements at all.
    expect(/^\s*import\s/m.test(code)).toBe(false);
  });

  it('makes no network / env / console calls', () => {
    expect(/\bfetch\s*\(/.test(code)).toBe(false);
    expect(/process\.env/.test(code)).toBe(false);
    expect(/console\./.test(code)).toBe(false);
  });

  it('reads no ambient clock', () => {
    expect(/Date\.now\s*\(/.test(code)).toBe(false);
    expect(/new\s+Date\s*\(/.test(code)).toBe(false);
  });
});
