// Hermetic proof for the handback-file seam (tree-7718eb70 node #1682).
// Touches NO database: JARVIS_UPLOADS_DIR points at a /tmp scratch dir and only
// image-store + handback-files (both DB-free) are imported.
// Run: JARVIS_UPLOADS_DIR=$(mktemp -d) npx tsx scripts/handback-files-check.ts
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, truncateSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.JARVIS_UPLOADS_DIR?.startsWith(os.tmpdir())) {
  console.error('refusing: set JARVIS_UPLOADS_DIR to a scratch dir under', os.tmpdir());
  process.exit(2);
}

const store = await import('../src/image-store.js');
const { stageHandbackFile, drainHandbackFiles } = await import('../src/handback-files.js');

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log('ok  ', name); }
  catch (e) { failed++; console.log('FAIL', name, '-', e instanceof Error ? e.message : e); }
}

const src = mkdtempSync(path.join(os.tmpdir(), 'handback-src-'));
const conv = 4242;
const csv = path.join(src, 'report.csv');
writeFileSync(csv, 'a,b\n1,2\n');

check('stage + drain returns then clears', () => {
  assert.equal(stageHandbackFile(conv, { absSourcePath: csv, name: 'Kevin Report.csv' }), 1);
  assert.equal(stageHandbackFile(conv, { absSourcePath: csv, name: 'Kevin Report.csv' }), 1, 're-stage dedupes');
  const d = drainHandbackFiles(conv);
  assert.equal(d.length, 1);
  assert.equal(d[0].absSourcePath, csv);
  assert.equal(drainHandbackFiles(conv).length, 0, 'second drain empty');
  assert.equal(drainHandbackFiles(9999).length, 0, 'other conv empty');
});

check('saveHandbackFile round-trips bytes + record; resolveFilePath finds it', () => {
  stageHandbackFile(conv, { absSourcePath: csv, name: 'Kevin Report.csv' });
  const [f] = drainHandbackFiles(conv);
  const saved = store.saveHandbackFile(conv, 7, f.absSourcePath, f.name);
  assert.equal(saved.name, 'Kevin_Report.csv');
  assert.equal(saved.mime, 'text/csv');
  assert.equal(saved.conversationId, conv);
  assert.match(saved.filename, /^t7-h[0-9a-f]{8}-Kevin_Report\.csv$/);
  assert.equal(readFileSync(saved.absPath, 'utf8'), 'a,b\n1,2\n');
  assert.equal(store.resolveFilePath(conv, saved.filename), saved.absPath);
  assert.ok(saved.absPath.startsWith(path.join(process.env.JARVIS_UPLOADS_DIR!, String(conv))));
  // the persisted JSON shape parses back with parseStoredFiles
  const json = JSON.stringify([{ filename: saved.filename, name: saved.name, mime: saved.mime, conversationId: saved.conversationId }]);
  assert.deepEqual(store.parseStoredFiles(json)[0].filename, saved.filename);
  // copy is a snapshot: editing the source later does not change the served bytes
  writeFileSync(csv, 'changed');
  assert.equal(readFileSync(saved.absPath, 'utf8'), 'a,b\n1,2\n');
});

check('same name twice -> two distinct on-disk files', () => {
  const a = store.saveHandbackFile(conv, 8, csv);
  const b = store.saveHandbackFile(conv, 8, csv);
  assert.notEqual(a.filename, b.filename);
  assert.equal(a.name, 'report.csv');
});

check('mime fallback for unknown extension', () => {
  const p = path.join(src, 'blob.weird');
  writeFileSync(p, 'x');
  assert.equal(store.saveHandbackFile(conv, 9, p).mime, 'application/octet-stream');
  assert.equal(store.mimeForFileName('shot.PNG'), 'image/png');
});

check('refuses a missing path', () => {
  assert.throws(() => store.saveHandbackFile(conv, 10, path.join(src, 'nope.txt')), store.FileValidationError);
});

check('refuses a directory', () => {
  const d = path.join(src, 'adir');
  mkdirSync(d);
  assert.throws(() => store.saveHandbackFile(conv, 10, d), /directory/);
});

check('refuses a relative path', () => {
  assert.throws(() => store.saveHandbackFile(conv, 10, 'report.csv'), /absolute/);
});

check('refuses an oversize (> MAX_FILE_BYTES) file', () => {
  const big = path.join(src, 'big.bin');
  writeFileSync(big, '');
  truncateSync(big, store.MAX_FILE_BYTES + 1); // sparse, no real disk use
  assert.throws(() => store.saveHandbackFile(conv, 10, big), /max size/);
  truncateSync(big, store.MAX_FILE_BYTES); // exactly at the cap is allowed
  assert.equal(store.checkHandbackSource(big), store.MAX_FILE_BYTES);
});

const { attachFile } = await import('../src/tools/attach-file-tool.js');
{
  const p = path.join(src, 'tool.txt');
  writeFileSync(p, 'hello');
  const r1 = (await attachFile.execute({ path: p, name: 'out.txt' }, { conversationId: 77 } as never)) as Record<string, unknown>;
  const r2 = (await attachFile.execute({ path: path.join(src, 'missing.txt') }, { conversationId: 77 } as never)) as Record<string, unknown>;
  const r3 = (await attachFile.execute({ path: p }, undefined)) as Record<string, unknown>;
  check('attach_file tool stages (no copy), rejects missing + no-conversation', () => {
    assert.equal(r1.ok, true);
    assert.equal(r1.attached, 'out.txt');
    assert.equal(r1.bytes, 5);
    assert.match(String(r2.error), /no such file/);
    assert.match(String(r3.error), /No active conversation/);
    const d = drainHandbackFiles(77);
    assert.deepEqual(d, [{ absSourcePath: p, name: 'out.txt' }]);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
