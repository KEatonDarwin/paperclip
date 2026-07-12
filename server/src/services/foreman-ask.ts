// Foreman Eye per-Job chat (DAR-720, Phase 1). Single-shot, read-only Q&A: assembles a
// Job's full tree into context and asks Claude to answer AS Foreman about its own job.
// Deliberately isolated from foreman-dispatch.ts (the coding-agent orchestration path) —
// this only ever reads job/task rows and makes a plain messages.create call.
import Anthropic from "@anthropic-ai/sdk";

const ASK_MODEL = process.env.FOREMAN_ASK_MODEL?.trim() || "claude-sonnet-5";
const MAX_ANSWER_TOKENS = 1024;

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

export async function askForemanAboutJob(job: JobRow, tasks: TaskRow[], question: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new ForemanAskError("ANTHROPIC_API_KEY is not configured on the server", "missing_api_key");
  }

  const client = new Anthropic({ apiKey });
  const context = buildContext(job, tasks);

  try {
    const message = await client.messages.create({
      model: ASK_MODEL,
      max_tokens: MAX_ANSWER_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Job context:\n\n${context}\n\nQuestion: ${question}`,
        },
      ],
    });
    const textBlock = message.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new ForemanAskError("model returned no text content", "empty_response");
    }
    return textBlock.text;
  } catch (err) {
    if (err instanceof ForemanAskError) throw err;
    throw new ForemanAskError(`Anthropic API call failed: ${(err as Error).message}`, "upstream_error");
  }
}
