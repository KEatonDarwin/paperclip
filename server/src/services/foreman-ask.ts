// Foreman Eye per-Job chat (DAR-720, Phase 1). Single-shot, read-only Q&A: assembles a
// Job's full tree into context and asks Claude to answer AS Foreman about its own job.
// Deliberately isolated from foreman-dispatch.ts (the coding-agent orchestration path) —
// this only ever reads job/task rows and shells out to the `claude` binary once.
//
// Paperclip never uses ANTHROPIC_API_KEY / the Anthropic SDK for model calls — every
// agent (JARVIS, chip-runner, foreman-dispatch) goes through the local `claude` CLI on
// subscription/login auth. This service follows the same convention: no API key, ever.
import { spawn } from "node:child_process";

const ASK_MODEL = process.env.FOREMAN_ASK_MODEL?.trim() || "claude-sonnet-5";
const CLAUDE_BIN = process.env.CLAUDE_BIN?.trim() || "claude";
const ASK_TIMEOUT_MS = 45_000;

export class ForemanAskError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

interface JobRow {
  id: string;
  repo: string;
  baseBranch: string;
  ask: string;
  jobType: string;
  status: string;
  integrationBranch: string | null;
  prUrl: string | null;
  mergeCommitSha: string | null;
  verifyResult: string | null;
  summary: string | null;
  errorMessage: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  completedAt: string | Date | null;
}

interface TaskRow {
  seq: number;
  instruction: string;
  workerType: string | null;
  status: string;
  branch: string | null;
  verifyResult: string | null;
  artifactDiff: string | null;
  retryCount: number;
  repairSignal: string | null;
  finalGate: string | null;
  errorMessage: string | null;
}

function formatTask(t: TaskRow): string {
  const lines = [
    `- Task ${t.seq + 1} [${t.status}]${t.workerType ? ` (${t.workerType})` : ""}: ${t.instruction}`,
  ];
  if (t.branch) lines.push(`  branch: ${t.branch}`);
  if (t.verifyResult) lines.push(`  verify: ${t.verifyResult}`);
  if (t.retryCount > 0) lines.push(`  retries: ${t.retryCount}`);
  if (t.repairSignal) lines.push(`  repair signal: ${t.repairSignal}`);
  if (t.finalGate) lines.push(`  final gate: ${t.finalGate}`);
  if (t.errorMessage) lines.push(`  error: ${t.errorMessage}`);
  if (t.artifactDiff) lines.push(`  diff summary: ${t.artifactDiff}`);
  return lines.join("\n");
}

function buildContext(job: JobRow, tasks: TaskRow[]): string {
  const sorted = [...tasks].sort((a, b) => a.seq - b.seq);
  return [
    `Job ID: ${job.id}`,
    `Repo: ${job.repo} (base branch: ${job.baseBranch})`,
    `Job type: ${job.jobType}`,
    `Status: ${job.status}`,
    `Ask: ${job.ask}`,
    job.integrationBranch ? `Integration branch: ${job.integrationBranch}` : null,
    job.verifyResult ? `Job verify result: ${job.verifyResult}` : null,
    job.prUrl ? `PR: ${job.prUrl}` : null,
    job.mergeCommitSha ? `Merge commit: ${job.mergeCommitSha}` : null,
    job.summary ? `Summary:\n${job.summary}` : null,
    job.errorMessage ? `Error: ${job.errorMessage}` : null,
    `Created: ${job.createdAt}`,
    `Updated: ${job.updatedAt}`,
    job.completedAt ? `Completed: ${job.completedAt}` : null,
    "",
    `Tasks (${sorted.length}):`,
    ...(sorted.length ? [sorted.map(formatTask).join("\n")] : ["(none decomposed yet)"]),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

const SYSTEM_PROMPT = `You are Foreman, an autonomous coding orchestrator. You are being asked a question by a human about a specific Job you (Foreman) ran or are running — your own work. Answer AS Foreman, in first person, grounded strictly in the Job context provided below. If the context doesn't contain the answer, say so plainly rather than guessing. Be concise and direct.`;

/** Pulls the final assistant answer out of `claude --output-format stream-json` JSONL. */
function parseClaudeAnswer(stdout: string): string {
  const texts: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (event.type === "assistant") {
      const content = (event.message as Record<string, unknown> | null)?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
        }
      }
    }

    if (event.type === "result") {
      const r = typeof event.result === "string" ? event.result.trim() : "";
      if (r) return r;
    }
  }
  return texts.join("").trim();
}

export async function askForemanAboutJob(job: JobRow, tasks: TaskRow[], question: string): Promise<string> {
  const context = buildContext(job, tasks);
  const prompt = `${SYSTEM_PROMPT}\n\n---\n\nJob context:\n\n${context}\n\nQuestion: ${question}`;

  // Mirrors the `claude` adapter's envOverrides in darwin-assistant/src/agent.ts —
  // strip ANTHROPIC_API_KEY so the CLI always uses local subscription/login auth,
  // never API-key billing.
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.ANTHROPIC_API_KEY;

  const args = [
    "--print",
    "-",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--model",
    ASK_MODEL,
  ];

  const { stdout, stderr, exitCode, timedOut } = await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  }>((resolve) => {
    const child = spawn(CLAUDE_BIN, args, { env });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, ASK_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => outChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      errChunks.push(Buffer.from(String(err?.message ?? err)));
      resolve({ stdout: "", stderr: Buffer.concat(errChunks).toString("utf-8"), exitCode: -1, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(outChunks).toString("utf-8"),
        stderr: Buffer.concat(errChunks).toString("utf-8"),
        exitCode: code,
        timedOut,
      });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });

  if (timedOut) {
    throw new ForemanAskError(`claude CLI timed out after ${ASK_TIMEOUT_MS}ms`, "timeout");
  }
  if (exitCode !== 0) {
    const stderrLine = stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
    throw new ForemanAskError(
      stderrLine ? `claude CLI exited with code ${exitCode}: ${stderrLine}` : `claude CLI exited with code ${exitCode}`,
      "upstream_error",
    );
  }

  const answer = parseClaudeAnswer(stdout);
  if (!answer) {
    throw new ForemanAskError("claude CLI returned no text content", "empty_response");
  }
  return answer;
}
