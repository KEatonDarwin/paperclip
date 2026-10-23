// INTEL DESK — one lane's local `claude` CLI invocation. Subscription/login
// auth only, per the NO-API-KEYS rule: ANTHROPIC_API_KEY (and any stray
// OPENAI_API_KEY) is stripped from the child env before spawning, exactly
// like briefing.ts's runDebrief / jarvis-brief.ts.

import { execFile } from 'node:child_process';
import { buildLaneOutputSchema, buildLanePrompt, type LanePromptOpts } from './lanes.js';
import { validateLaneOutput } from './validate.js';
import type { IntelLane, NewIntelItem } from './store.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN || process.env.UX_REVIEWER_CLAUDE_BIN || 'claude';
const LANE_MODEL = process.env.INTEL_PULL_MODEL || 'claude-sonnet-5';
const LANE_TIMEOUT_MS = 180_000;
const MAX_BUFFER = 20 * 1024 * 1024;

export interface LaneResult {
  lane: IntelLane;
  ok: boolean;
  digest: string;
  items: NewIntelItem[];
  error?: string;
}

interface ClaudeResultEnvelope {
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
}

function runLaneClaude(prompt: string, schema: Record<string, unknown>): Promise<string> {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;

  return new Promise((resolve, reject) => {
    const child = execFile(
      CLAUDE_BIN,
      [
        '-p', prompt,
        '--model', LANE_MODEL,
        '--output-format', 'json',
        // Research-only session: the model only ever SEES web tools (no
        // Bash/Edit/Write, no MCP servers), and anything else that would
        // prompt is auto-denied. Fetched pages are untrusted — an injected
        // "run this command" has no tool to land on.
        '--tools', 'WebSearch,WebFetch',
        '--allowedTools', 'WebSearch', 'WebFetch',
        '--strict-mcp-config',
        '--permission-prompts', 'none',
        '--json-schema', JSON.stringify(schema),
      ],
      { env, timeout: LANE_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error(`claude call failed: ${err.message}${stderr ? ` | ${stderr.slice(0, 200)}` : ''}`));
          return;
        }
        resolve(stdout);
      },
    );
    // Prompt rides in argv; close stdin so the CLI doesn't wait on piped input.
    child.stdin?.end();
  });
}

/** Run one lane end to end: compose prompt, invoke claude, parse + validate.
 *  Never throws — a lane failure is reported as `{ok: false}` so the other
 *  lanes still run (v0 is sequential-by-lane, partial success is fine). */
export async function runLane(lane: IntelLane, promptOpts: LanePromptOpts): Promise<LaneResult> {
  const prompt = buildLanePrompt(lane, promptOpts);
  const schema = buildLaneOutputSchema(lane);

  try {
    const stdout = await runLaneClaude(prompt, schema);

    let envelope: ClaudeResultEnvelope;
    try {
      envelope = JSON.parse(stdout.trim()) as ClaudeResultEnvelope;
    } catch {
      throw new Error('claude output was not a valid JSON envelope');
    }

    if (envelope.is_error) {
      throw new Error(`claude reported an error: ${String(envelope.result ?? '').slice(0, 200)}`);
    }

    let raw: unknown = envelope.structured_output;
    if (raw === undefined && typeof envelope.result === 'string') {
      try {
        raw = JSON.parse(envelope.result);
      } catch {
        throw new Error('claude result was not parseable JSON');
      }
    }
    if (raw === undefined || raw === null) {
      throw new Error('claude envelope had no structured_output/result');
    }

    const { digest, items } = validateLaneOutput(lane, raw);
    return { lane, ok: true, digest, items };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      lane,
      ok: false,
      digest: `(${lane} lane failed: ${message.slice(0, 150)})`,
      items: [],
      error: message,
    };
  }
}
