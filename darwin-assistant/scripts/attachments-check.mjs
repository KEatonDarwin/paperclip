#!/usr/bin/env node
// CHAT FILE ATTACHMENTS — API ROUTE + STORE CHECKS (tree-9b58ddb7 node #1392)
// Exercises the REAL Express router over real HTTP on a throwaway port against
// a scratch DB and a scratch uploads dir. No model calls, no live jarvis.db,
// no live uploads directory.
//
//   npm run attachments:check
//
// Proves:
//   1. Every attachment route requires a bearer token.
//   2. POST stores a markdown file: row + bytes on disk under
//      uploads/<conversationId>/files/<uuid>.md, kind 'text'.
//   3. A mime the browser got wrong (application/octet-stream for .md) still
//      resolves by extension; a .sh is rejected; an unknown type is rejected.
//   4. GET lists the thread's attachments; the download URL serves the exact
//      bytes with the right mime and the ORIGINAL filename.
//   5. Cross-thread isolation: thread B cannot read/rename/delete thread A's
//      attachment id (404, not a leak), even with the same valid bearer.
//   6. PUT renames, and PUT with data replaces the bytes (and refuses a
//      replacement whose extension doesn't match what's on disk).
//   7. DELETE removes both the row and the file.
//   8. GET /attachments lists across threads with external_id + title, and
//      honours the ?external_id= filter.
//   9. buildAttachmentModelBlock inlines text files as ```file: <name>```,
//      truncates past the cap, and references binary files by name only.
//  10. POST /messages with attachment_ids validates ownership (404 on a
//      foreign id) and stamps turn_index on the ones it accepts.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── scratch guards ───────────────────────────────────────────────────────────
const raw = process.env.JARVIS_DB_PATH;
if (!raw || !raw.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path.');
  process.exit(1);
}
const DB_PATH = path.resolve(raw);
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'attachments-check-uploads-'));
process.env.JARVIS_UPLOADS_DIR = UPLOADS;

const distDir = path.join(__dirname, '..', 'dist');
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const { getOrCreateConversation, listAttachments, getAttachment } =
  await import(path.join(distDir, 'conversation-db.js'));
const { buildAttachmentModelBlock, resolveType, AttachmentValidationError, MAX_INLINE_TEXT_BYTES } =
  await import(path.join(distDir, 'attachment-store.js'));

const convA = getOrCreateConversation('cockpit:attach-check-a');
const convB = getOrCreateConversation('cockpit:attach-check-b');

const app = express();
app.use(express.json({ limit: '30mb' }));
app.use('/api/v1', createApiV1Router());
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const port = server.address().port;
const base = `http://127.0.0.1:${port}/api/v1`;
const token = mintApiKey('attachments-check', 'admin').plaintext;

async function req(method, urlPath, { body, noAuth, rawResponse } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (!noAuth) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (rawResponse) return res;
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const A = encodeURIComponent('cockpit:attach-check-a');
const B = encodeURIComponent('cockpit:attach-check-b');

let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

try {
  // 1. auth gate
  {
    for (const [m, p] of [['GET', `/threads/${A}/attachments`], ['POST', `/threads/${A}/attachments`], ['GET', '/attachments']]) {
      const r = await req(m, p, { noAuth: true, body: m === 'POST' ? { data: b64('x') } : undefined });
      assert.equal(r.status, 401, `${m} ${p} expected 401, got ${r.status}`);
    }
  }
  ok('every attachment route requires a bearer token');

  // 2. POST a markdown file
  const mdBody = '# Notes\n\nhello from kevin\n';
  let mdId;
  {
    const r = await req('POST', `/threads/${A}/attachments`, {
      body: { name: 'notes.md', mime: 'text/markdown', data: b64(mdBody) },
    });
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.json)}`);
    const a = r.json.attachment;
    mdId = a.id;
    assert.equal(a.name, 'notes.md');
    assert.equal(a.mime, 'text/markdown');
    assert.equal(a.kind, 'text');
    assert.equal(a.bytes, Buffer.byteLength(mdBody));
    assert.equal(a.source, 'chat');
    assert.equal(a.turn_index, null, 'a freshly uploaded file is not yet attached to a turn');
    assert.equal(a.download_url, `/threads/${A}/attachments/${a.id}/download`);
    const row = getAttachment(a.id);
    const onDisk = path.join(UPLOADS, String(convA.id), 'files', row.stored_filename);
    assert.ok(fs.existsSync(onDisk), `bytes should be at uploads/<conv>/files/: ${onDisk}`);
    assert.equal(fs.readFileSync(onDisk, 'utf8'), mdBody);
    assert.match(row.stored_filename, /^[0-9a-f-]{36}\.md$/, 'stored name must be a server-generated uuid.ext');
  }
  ok('POST stores a .md file as kind=text under uploads/<conv>/files/<uuid>.md');

  // 3. mime resolution + rejections
  {
    const octet = await req('POST', `/threads/${A}/attachments`, {
      body: { name: 'README.md', mime: 'application/octet-stream', data: b64('x') },
    });
    assert.equal(octet.status, 201, 'octet-stream for a .md must resolve by extension');
    assert.equal(octet.json.attachment.mime, 'text/markdown');

    const sh = await req('POST', `/threads/${A}/attachments`, {
      body: { name: 'evil.sh', mime: 'text/plain', data: b64('rm -rf /') },
    });
    assert.equal(sh.status, 400, 'a .sh must be rejected even as text/plain');

    const weird = await req('POST', `/threads/${A}/attachments`, {
      body: { name: 'thing.xyz', mime: 'application/x-weird', data: b64('x') },
    });
    assert.equal(weird.status, 400, 'an unknown type must be rejected');

    assert.throws(() => resolveType('text/plain', 'go.exe'), AttachmentValidationError);
    assert.deepEqual(resolveType('application/json', 'a.json'), { mime: 'application/json', ext: 'json' });
  }
  ok('mime resolves by extension when the browser lies; scripts/unknown types are rejected');

  // 4. list + download
  {
    const list = await req('GET', `/threads/${A}/attachments`);
    assert.equal(list.status, 200);
    assert.equal(list.json.attachments.length, 2, 'notes.md + README.md');

    const res = await req('GET', `/threads/${A}/attachments/${mdId}/download`, { rawResponse: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/markdown/);
    assert.match(res.headers.get('content-disposition') ?? '', /filename="notes\.md"/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(await res.text(), mdBody);

    // An honest text/html upload must come back as text/plain: nosniff only
    // stops type guessing, and a rendered upload would execute on the
    // cockpit's own origin (where the SSR proxy holds the bearer).
    const htmlBody = '<script>alert(1)</script>';
    const up = await req('POST', `/threads/${A}/attachments`, {
      body: { name: 'evil.html', mime: 'text/html', data: b64(htmlBody) },
    });
    assert.equal(up.status, 201);
    const served = await req('GET', `/threads/${A}/attachments/${up.json.attachment.id}/download`, { rawResponse: true });
    assert.match(served.headers.get('content-type') ?? '', /text\/plain/);
    assert.doesNotMatch(served.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(await served.text(), htmlBody, 'the bytes are intact, only the Content-Type is defanged');
    await req('DELETE', `/threads/${A}/attachments/${up.json.attachment.id}`);
  }
  ok('GET lists the thread\'s files; download serves exact bytes, nosniff + sandbox CSP, and defangs text/html');

  // 5. cross-thread isolation
  {
    const get = await req('GET', `/threads/${B}/attachments/${mdId}/download`);
    assert.equal(get.status, 404, `thread B must not read A's attachment, got ${get.status}`);
    const put = await req('PUT', `/threads/${B}/attachments/${mdId}`, { body: { name: 'stolen.md' } });
    assert.equal(put.status, 404);
    const del = await req('DELETE', `/threads/${B}/attachments/${mdId}`);
    assert.equal(del.status, 404);
    assert.equal(getAttachment(mdId).original_name, 'notes.md', 'the row must be untouched');
    assert.equal(listAttachments(convB.id).length, 0);
  }
  ok('cross-thread access to another thread\'s attachment id is a 404 on read, rename and delete');

  // 6. rename + replace content
  {
    const rename = await req('PUT', `/threads/${A}/attachments/${mdId}`, { body: { name: 'kevin-notes.md' } });
    assert.equal(rename.status, 200);
    assert.equal(rename.json.attachment.name, 'kevin-notes.md');

    const newBody = '# Replaced\n\nmuch longer body now\n';
    const replace = await req('PUT', `/threads/${A}/attachments/${mdId}`, {
      body: { name: 'kevin-notes.md', mime: 'text/markdown', data: b64(newBody) },
    });
    assert.equal(replace.status, 200, JSON.stringify(replace.json));
    assert.equal(replace.json.attachment.bytes, Buffer.byteLength(newBody));
    const served = await req('GET', `/threads/${A}/attachments/${mdId}/download`, { rawResponse: true });
    assert.equal(await served.text(), newBody, 'the download must serve the replaced bytes');

    const wrongExt = await req('PUT', `/threads/${A}/attachments/${mdId}`, {
      body: { name: 'kevin-notes.md', mime: 'application/json', data: b64('{}') },
    });
    assert.equal(wrongExt.status, 400, 'replacing .md content with .json must be refused');

    const nothing = await req('PUT', `/threads/${A}/attachments/${mdId}`, { body: {} });
    assert.equal(nothing.status, 400);
  }
  ok('PUT renames, replaces bytes in place, and refuses an extension-changing replace');

  // 7. delete removes row + file
  {
    const extra = await req('POST', `/threads/${A}/attachments`, {
      body: { name: 'throwaway.txt', mime: 'text/plain', data: b64('bye') },
    });
    const id = extra.json.attachment.id;
    const stored = getAttachment(id).stored_filename;
    const onDisk = path.join(UPLOADS, String(convA.id), 'files', stored);
    assert.ok(fs.existsSync(onDisk));
    const del = await req('DELETE', `/threads/${A}/attachments/${id}`);
    assert.equal(del.status, 200);
    assert.equal(getAttachment(id), undefined, 'row must be gone');
    assert.ok(!fs.existsSync(onDisk), 'file must be gone');
  }
  ok('DELETE removes both the row and the bytes on disk');

  // 8. cross-thread settings list
  {
    await req('POST', `/threads/${B}/attachments`, {
      body: { name: 'b-side.csv', mime: 'text/csv', data: b64('a,b\n1,2\n'), source: 'settings' },
    });
    const all = await req('GET', '/attachments');
    assert.equal(all.status, 200);
    const ids = all.json.attachments.map((a) => a.conversation_external_id);
    assert.ok(ids.includes('cockpit:attach-check-a'), 'should include thread A');
    assert.ok(ids.includes('cockpit:attach-check-b'), 'should include thread B');
    assert.ok(all.json.attachments.every((a) => 'conversation_title' in a), 'each row carries its thread title');
    const bOnly = await req('GET', `/attachments?external_id=${B}`);
    assert.equal(bOnly.json.attachments.length, 1);
    assert.equal(bOnly.json.attachments[0].name, 'b-side.csv');
    assert.equal(bOnly.json.attachments[0].source, 'settings');
  }
  ok('GET /attachments spans threads with external_id + title, and ?external_id= filters');

  // 9. the model block
  {
    const conversationId = convA.id;
    const rows = listAttachments(conversationId);
    const md = rows.find((r) => r.original_name === 'kevin-notes.md');
    const block = buildAttachmentModelBlock([{
      originalName: md.original_name,
      storedFilename: md.stored_filename,
      mime: md.mime,
      bytes: md.bytes,
      kind: md.kind,
      conversationId,
    }]);
    assert.match(block, /```file: kevin-notes\.md/, 'text files are inlined as a fenced file block');
    assert.match(block, /# Replaced/);

    // binary: a pdf is referenced, never inlined
    const pdf = await req('POST', `/threads/${A}/attachments`, {
      body: { name: 'deck.pdf', mime: 'application/pdf', data: b64('%PDF-1.4 fake') },
    });
    const pdfRow = getAttachment(pdf.json.attachment.id);
    assert.equal(pdfRow.kind, 'binary');
    const pdfBlock = buildAttachmentModelBlock([{
      originalName: pdfRow.original_name,
      storedFilename: pdfRow.stored_filename,
      mime: pdfRow.mime,
      bytes: pdfRow.bytes,
      kind: pdfRow.kind,
      conversationId,
    }]);
    assert.match(pdfBlock, /attached file: deck\.pdf \(application\/pdf, \d+ bytes\)/);
    assert.ok(!pdfBlock.includes('```file:'), 'a binary file must never be inlined');

    // truncation past the cap
    const big = 'x'.repeat(MAX_INLINE_TEXT_BYTES + 5000);
    const bigUp = await req('POST', `/threads/${A}/attachments`, {
      body: { name: 'big.txt', mime: 'text/plain', data: b64(big) },
    });
    const bigRow = getAttachment(bigUp.json.attachment.id);
    const bigBlock = buildAttachmentModelBlock([{
      originalName: bigRow.original_name,
      storedFilename: bigRow.stored_filename,
      mime: bigRow.mime,
      bytes: bigRow.bytes,
      kind: bigRow.kind,
      conversationId,
    }]);
    assert.match(bigBlock, /\[truncated — showing the first \d+ of \d+ bytes/);
    assert.ok(bigBlock.length < MAX_INLINE_TEXT_BYTES + 2000, 'the block must actually be capped');
  }
  ok('model block inlines text as ```file:```, references binaries, truncates past the cap');

  // 10. POST /messages ownership + turn stamping
  {
    const foreign = listAttachments(convB.id)[0];
    const bad = await req('POST', `/threads/${A}/messages`, {
      body: { text: 'look at this', attachment_ids: [foreign.id] },
    });
    assert.equal(bad.status, 404, `a foreign attachment id must 404, got ${bad.status}`);

    const nan = await req('POST', `/threads/${A}/messages`, {
      body: { text: 'hi', attachment_ids: ['nope'] },
    });
    assert.equal(nan.status, 400);

    // The real send path spawns a model turn, which the sim guard refuses in a
    // scratch DB — processMessage returns its marker instead. The route still
    // accepts (202) and stamps turn_index synchronously, which is what we check.
    const own = listAttachments(convA.id).find((r) => r.original_name === 'kevin-notes.md');
    const sent = await req('POST', `/threads/${A}/messages`, {
      body: { text: 'read this file', attachment_ids: [own.id] },
    });
    assert.equal(sent.status, 202, `expected 202, got ${sent.status}: ${JSON.stringify(sent.json)}`);
    assert.equal(getAttachment(own.id).turn_index, 0, 'turn_index must be stamped on send');
  }
  ok('POST /messages rejects foreign/invalid attachment_ids and stamps turn_index on its own');

  console.log(`\n[attachments-check] ALL ${passed} checks passed ✅`);
} finally {
  server.close();
  fs.rmSync(UPLOADS, { recursive: true, force: true });
}
