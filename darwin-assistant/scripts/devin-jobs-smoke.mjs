#!/usr/bin/env node
import express from 'express';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const originalDevinApiKey = process.env.DEVIN_API_KEY?.trim() || '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function startMockDevinServer() {
  const sessions = new Map();
  let counter = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://mock.local');
      if (!req.headers.authorization?.startsWith('Bearer ')) {
        json(res, 401, { error: 'missing bearer' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v3/self') {
        json(res, 200, { org_id: 'org_mock' });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v3/organizations/org_mock/sessions') {
        const body = await readJson(req);
        counter += 1;
        const session = {
          session_id: `mock-session-${counter}`,
          title: body.title,
          status: 'running',
          status_detail: 'working',
          acus_consumed: 0.01,
          url: `https://app.devin.ai/sessions/mock-session-${counter}`,
          structured_output: null,
          tags: Array.isArray(body.tags) ? body.tags : [],
          devin_mode: body.devin_mode ?? 'lite',
          created_at: new Date().toISOString(),
        };
        sessions.set(session.session_id, session);
        json(res, 200, session);
        return;
      }

      const sessionMatch = url.pathname.match(/^\/v3\/organizations\/org_mock\/sessions\/([^/]+)$/);
      if (req.method === 'GET' && sessionMatch) {
        const session = sessions.get(decodeURIComponent(sessionMatch[1]));
        if (!session) {
          json(res, 404, { error: 'not_found' });
          return;
        }
        json(res, 200, {
          ...session,
          status: 'exit',
          status_detail: 'finished',
          acus_consumed: 0.12,
          structured_output: {
            outcome: 'done',
            summary: 'mock Devin job completed',
            branch: 'hopper/devin-jobs',
            commits: ['mock-commit'],
            notes: ['smoke verified quoted structured output'],
          },
        });
        return;
      }

      const messageMatch = url.pathname.match(/^\/v3\/organizations\/org_mock\/sessions\/([^/]+)\/messages$/);
      if (req.method === 'POST' && messageMatch) {
        const session = sessions.get(decodeURIComponent(messageMatch[1]));
        if (!session) {
          json(res, 404, { error: 'not_found' });
          return;
        }
        json(res, 200, session);
        return;
      }

      json(res, 404, { error: 'unhandled mock path', path: url.pathname });
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert(address && typeof address === 'object', 'mock Devin server did not bind a TCP port');
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/v3` });
    });
  });
}

function startApiServer(createApiV1Router) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/v1', createApiV1Router());
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert(address && typeof address === 'object', 'API smoke server did not bind a TCP port');
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/api/v1` });
    });
  });
}

async function apiFetch(baseUrl, key, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const jsonBody = await res.json().catch(() => null);
  return { status: res.status, body: jsonBody };
}

async function runPollerNoKey(dbPath, outputPath) {
  await execFileAsync(process.execPath, ['dist/scripts/poll-devin-usage.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      JARVIS_DB_PATH: dbPath,
      DEVIN_API_KEY: '',
      DEVIN_USAGE_FILE: outputPath,
    },
    timeout: 15_000,
  });
  const snapshot = JSON.parse(await readFile(outputPath, 'utf8'));
  assert(snapshot.status === 'key_needed', `expected key_needed meter, got ${snapshot.status}`);
  assert(snapshot.windows?.[0]?.value_label === 'key needed for usage', 'key_needed meter label drifted');
  return snapshot;
}

async function fetchDevinJson(apiKey, path, init = {}) {
  const res = await fetch(`https://api.devin.ai/v3${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`live Devin ${path} returned HTTP ${res.status}: ${body.message ?? body.error ?? text}`);
  return body;
}

async function runLiveSmoke(apiKey) {
  const started = Date.now();
  const self = await fetchDevinJson(apiKey, '/self');
  assert(typeof self.org_id === 'string' && self.org_id, 'live /self did not return org_id');
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['outcome', 'summary'],
    properties: {
      outcome: { type: 'string', enum: ['done', 'blocked'] },
      summary: { type: 'string' },
      branch: { type: ['string', 'null'] },
      commits: { type: ['array', 'null'], items: { type: 'string' } },
      notes: { type: ['array', 'null'], items: { type: 'string' } },
    },
  };
  const created = await fetchDevinJson(apiKey, `/organizations/${encodeURIComponent(self.org_id)}/sessions`, {
    method: 'POST',
    body: JSON.stringify({
      title: 'JARVIS Devin jobs smoke',
      prompt:
        'This is a JARVIS smoke test. Do not edit files or contact external systems. Return structured output immediately with outcome done and a short summary.',
      devin_mode: 'lite',
      structured_output_required: true,
      structured_output_schema: schema,
      tags: ['jarvis', 'devin-jobs', 'smoke'],
    }),
  });

  let latest = created;
  for (let i = 0; i < 60; i += 1) {
    if (latest.status === 'exit' || latest.status === 'error') break;
    await delay(5_000);
    latest = await fetchDevinJson(
      apiKey,
      `/organizations/${encodeURIComponent(self.org_id)}/sessions/${encodeURIComponent(created.session_id)}`,
    );
  }

  return {
    ran: true,
    session_id: latest.session_id ?? created.session_id,
    status: latest.status ?? null,
    status_detail: latest.status_detail ?? null,
    acus_consumed: typeof latest.acus_consumed === 'number' ? latest.acus_consumed : null,
    seconds: Math.round((Date.now() - started) / 1000),
    url: latest.url ?? created.url ?? null,
  };
}

const scratchDir = await mkdtemp(join(tmpdir(), 'devin-jobs-smoke-'));
const dbPath = join(scratchDir, 'scratch.db');
const usagePath = join(scratchDir, 'devin-usage-live.json');
const pollerNoKeyPath = join(scratchDir, 'devin-usage-key-needed.json');

let mockServer;
let apiServer;

try {
  const mock = await startMockDevinServer();
  mockServer = mock.server;

  process.env.JARVIS_DB_PATH = dbPath;
  process.env.DEVIN_USAGE_FILE = usagePath;
  process.env.DEVIN_API_BASE = mock.baseUrl;
  process.env.DEVIN_API_KEY = '';

  const { mintApiKey } = await import('../dist/api-keys.js');
  const { createApiV1Router } = await import('../dist/handlers/api-v1.js');
  const { sqliteDb, setSetting } = await import('../dist/conversation-db.js');
  const {
    insertLocalPendingDevinJob,
    attachDevinSession,
    updateDevinJobFromSession,
    serializeDevinJob,
    getDevinJob,
    listDevinJobs,
    markDevinJobCreateFailed,
    markDevinJobSettled,
  } = await import('../dist/devin-jobs.js');
  const { createHopperTree, getHopperNode } = await import('../dist/hopper-engine.js');
  const { reconcileDevinJobsOnce } = await import('../dist/devin-jobs-reconciler.js');

  const { plaintext: bearer } = mintApiKey('devin-jobs-smoke', 'cockpit');
  const api = await startApiServer(createApiV1Router);
  apiServer = api.server;

  const crud = insertLocalPendingDevinJob({
    title: 'CRUD smoke',
    promptSummary: 'exercise local devin_jobs CRUD',
    devinMode: 'lite',
    tags: ['jarvis', 'devin-jobs', 'smoke'],
    nodeId: null,
    threadExt: null,
  });
  attachDevinSession(crud.id, {
    session_id: 'crud-session',
    status: 'running',
    status_detail: 'working',
    acus_consumed: 0.01,
    url: 'https://app.devin.ai/sessions/crud-session',
    structured_output: null,
    tags: ['jarvis', 'devin-jobs', 'smoke'],
    devin_mode: 'lite',
  });
  updateDevinJobFromSession(crud.id, {
    session_id: 'crud-session',
    status: 'exit',
    status_detail: 'finished',
    acus_consumed: 0.02,
    url: 'https://app.devin.ai/sessions/crud-session',
    structured_output: { outcome: 'done', summary: 'CRUD path settled' },
    tags: ['jarvis', 'devin-jobs', 'smoke'],
    devin_mode: 'lite',
  });
  const serializedCrud = serializeDevinJob(getDevinJob(crud.id));
  assert(serializedCrud.structured_output?.summary === 'CRUD path settled', 'CRUD structured_output did not serialize');
  assert(listDevinJobs('all', 10).some((job) => job.id === crud.id), 'CRUD list did not include inserted row');
  markDevinJobSettled(crud.id);

  let response = await apiFetch(api.baseUrl, bearer, '/devin/jobs', {
    title: 'No-key guard',
    prompt: 'should not dispatch without a key',
  });
  assert(response.status === 409, `no-key guard returned ${response.status}`);
  assert(response.body?.error?.code === 'devin_key_missing', 'no-key guard error code drifted');
  assert(String(response.body?.error?.message ?? '').includes('DEVIN_API_KEY'), 'no-key guard message missing DEVIN_API_KEY');

  process.env.DEVIN_API_KEY = 'mock-devin-key';

  setSetting('devin_max_concurrent', '1');
  const active = insertLocalPendingDevinJob({
    title: 'Active concurrency blocker',
    promptSummary: 'keeps active count at the ceiling',
    devinMode: 'lite',
    tags: ['jarvis', 'devin-jobs', 'smoke'],
    nodeId: null,
    threadExt: null,
  });
  response = await apiFetch(api.baseUrl, bearer, '/devin/jobs', {
    title: 'Concurrency guard',
    prompt: 'should not dispatch at concurrency ceiling',
  });
  assert(response.status === 409, `concurrency guard returned ${response.status}`);
  assert(response.body?.error?.code === 'devin_concurrency_limit', 'concurrency guard error code drifted');
  markDevinJobCreateFailed(active.id, 'smoke cleanup');
  setSetting('devin_max_concurrent', '5');

  await writeFile(usagePath, JSON.stringify({ used_acus: 12 }, null, 2));
  setSetting('gov_devin_acu_ceiling', '12');
  response = await apiFetch(api.baseUrl, bearer, '/devin/jobs', {
    title: 'ACU guard',
    prompt: 'should not dispatch at ACU ceiling',
  });
  assert(response.status === 409, `ACU guard returned ${response.status}`);
  assert(response.body?.error?.code === 'devin_acu_ceiling', 'ACU guard error code drifted');
  setSetting('gov_devin_acu_ceiling', '100');

  const { nodes } = createHopperTree('devin-jobs smoke', 'smoke', [
    { title: 'mock Devin node', spec: 'finish through the Devin jobs reconciler', adapter: 'devin', model: 'lite' },
  ]);
  sqliteDb.prepare(`UPDATE hopper_nodes SET status = 'running' WHERE id = ?`).run(nodes[0].id);

  response = await apiFetch(api.baseUrl, bearer, '/devin/jobs', {
    title: 'Reconciler settle smoke',
    prompt: 'mock session should settle as done',
    node_id: nodes[0].id,
    tags: ['smoke'],
  });
  assert(response.status === 201, `create happy path returned ${response.status}: ${JSON.stringify(response.body)}`);
  const createdJobId = response.body?.job?.id;
  assert(typeof createdJobId === 'number', 'create happy path did not return a numeric job id');

  await reconcileDevinJobsOnce();
  const settledJob = getDevinJob(createdJobId);
  assert(settledJob?.settled_at, 'reconciler did not mark job settled');
  const settledNode = getHopperNode(nodes[0].id);
  assert(settledNode?.status === 'done', `hopper node did not finish done; got ${settledNode?.status}`);
  assert(
    String(settledNode.result ?? '').includes('UNTRUSTED WORKER REPORT (quoted)'),
    'hopper result missing untrusted quoted report frame',
  );
  assert(String(settledNode.result ?? '').includes('> summary: mock Devin job completed'), 'hopper result missing quoted summary');

  const keyNeededSnapshot = await runPollerNoKey(dbPath, pollerNoKeyPath);
  const live =
    originalDevinApiKey
      ? await runLiveSmoke(originalDevinApiKey)
      : { ran: false, reason: 'DEVIN_API_KEY was not present in this worker environment' };

  const summary = {
    scratch_dir: scratchDir,
    mock: {
      store_crud: 'ok',
      no_key_guard: 'ok',
      concurrency_guard: 'ok',
      acu_guard: 'ok',
      reconciler_finish_frame: 'ok',
      meter_key_needed: keyNeededSnapshot.windows[0].value_label,
      settled_job_id: createdJobId,
      hopper_node_id: nodes[0].id,
    },
    live,
  };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await new Promise((resolve) => (apiServer ? apiServer.close(resolve) : resolve()));
  await new Promise((resolve) => (mockServer ? mockServer.close(resolve) : resolve()));
}
