import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { buildPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (isFinite(parsed)) return parsed;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Ollama API types
// ---------------------------------------------------------------------------

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}

interface OllamaChatResponse {
  message: OllamaMessage;
  done: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

// ---------------------------------------------------------------------------
// Ollama tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    type: "function",
    function: {
      name: "call_paperclip_api",
      description:
        "Make a Paperclip REST API call. Use this for all Paperclip operations: reading issues, posting comments, updating status, checking inbox, etc.",
      parameters: {
        type: "object",
        properties: {
          method: {
            type: "string",
            enum: ["GET", "POST", "PATCH", "PUT", "DELETE"],
            description: "HTTP method",
          },
          path: {
            type: "string",
            description:
              "API path starting with /api, e.g. /api/agents/me or /api/issues/{issueId}/comments",
          },
          body: {
            type: "object",
            description: "Request body for POST/PATCH/PUT requests (omit for GET/DELETE)",
          },
        },
        required: ["method", "path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description:
        "End this heartbeat session. Call this when you have completed all work or determined there is nothing to do.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Brief summary of what was done or why you are finishing",
          },
        },
        required: ["summary"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  agentId: string,
  companyId: string,
  runId: string,
  apiUrl: string,
  extra: string,
): string {
  return `You are an AI agent running inside Paperclip, an agentic work management platform.

## Your Identity
- Agent ID: ${agentId}
- Company ID: ${companyId}
- Current Run ID: ${runId}
- Paperclip API URL: ${apiUrl}

## Your Job
You wake up periodically (heartbeats) to check if there is work assigned to you and act on it.
Each heartbeat, you should:
1. Check your inbox: GET /api/agents/me/inbox-lite
2. If there is work (todo/in_progress/blocked issues), pick the highest priority task
3. Checkout the task: POST /api/issues/{issueId}/checkout with {"agentId": "${agentId}", "expectedStatuses": ["todo", "backlog", "blocked"]}
4. Read the task context: GET /api/issues/{issueId}/heartbeat-context
5. Do the work (read comments, post updates, change status, create subtasks, etc.)
6. Update the issue status and leave a comment explaining what you did
7. Call finish() when done

## Critical Rules
- ALWAYS checkout before working on a task
- NEVER retry a 409 conflict — it means someone else owns the task
- ALWAYS include "X-Paperclip-Run-Id: ${runId}" header on all mutating API calls (checkout, PATCH, POST comments)
- If a task is complex and needs a more capable AI model, leave a comment explaining what needs to be done and set status to blocked, or @-mention the appropriate agent
- If your inbox is empty, call finish() immediately
- Be concise and action-oriented. Don't overthink simple tasks.

## API Notes
- All requests need: Authorization: Bearer <your-auth-token> (auto-injected)
- Mutating requests need: X-Paperclip-Run-Id: ${runId}
- Status values: backlog, todo, in_progress, in_review, done, blocked, cancelled
- Priority values: critical, high, medium, low
${extra ? `\n## Additional Instructions\n${extra}` : ""}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function callOllamaChat(
  baseUrl: string,
  model: string,
  messages: OllamaMessage[],
  timeoutMs: number,
): Promise<OllamaChatResponse> {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        tools: TOOLS,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Ollama /api/chat returned ${res.status}: ${body}`);
    }

    return (await res.json()) as OllamaChatResponse;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function callPaperclipApi(
  apiUrl: string,
  authToken: string,
  runId: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: unknown }> {
  const isGet = method === "GET" || method === "DELETE";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${authToken}`,
  };
  if (!isGet) {
    headers["x-paperclip-run-id"] = runId;
  }

  const url = `${apiUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: !isGet && body ? JSON.stringify(body) : undefined,
  });

  let data: unknown;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  return { status: res.status, data };
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, authToken } = ctx;

  const baseUrl = asString(config.baseUrl, "").replace(/\/$/, "");
  if (!baseUrl) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "ollama_local adapter requires baseUrl in adapterConfig",
    };
  }

  const model = asString(config.model, "");
  if (!model) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "ollama_local adapter requires model in adapterConfig",
    };
  }

  const maxTurns = asNumber(config.maxTurns, 20);
  const timeoutSec = asNumber(config.timeoutSec, 60);
  const timeoutMs = timeoutSec * 1000;
  const systemPromptExtra = asString(config.systemPromptExtra, "");

  // Resolve the Paperclip API URL and auth token
  const paperclipEnv = buildPaperclipEnv(agent);
  const apiUrl = paperclipEnv.PAPERCLIP_API_URL;
  const token = authToken ?? "";

  if (!token) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "ollama_local adapter: no auth token available",
    };
  }

  await onLog("stderr", `[ollama] Starting heartbeat: model=${model} baseUrl=${baseUrl} maxTurns=${maxTurns}\n`);

  // Build the initial context message from wake context
  const taskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim()
      ? context.wakeReason.trim()
      : "timer";
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim()) ||
    null;

  let userMessage = `You have been woken up. Wake reason: ${wakeReason}.`;
  if (taskId) userMessage += ` Task ID: ${taskId}.`;
  if (wakeCommentId) userMessage += ` Wake comment ID: ${wakeCommentId}.`;
  userMessage += "\n\nStart by checking your inbox with GET /api/agents/me/inbox-lite and proceed from there.";

  const systemPrompt = buildSystemPrompt(agent.id, agent.companyId, runId, apiUrl, systemPromptExtra);

  const messages: OllamaMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let finishSummary = "";
  let timedOut = false;

  while (turns < maxTurns) {
    turns++;
    await onLog("stderr", `[ollama] Turn ${turns}/${maxTurns}\n`);

    let response: OllamaChatResponse;
    try {
      response = await callOllamaChat(baseUrl, model, messages, timeoutMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("AbortError") || msg.toLowerCase().includes("abort")) {
        timedOut = true;
        await onLog("stderr", `[ollama] Request timed out after ${timeoutSec}s\n`);
      } else {
        await onLog("stderr", `[ollama] Ollama API error: ${msg}\n`);
      }
      break;
    }

    inputTokens += response.prompt_eval_count ?? 0;
    outputTokens += response.eval_count ?? 0;

    const assistantMessage = response.message;
    messages.push(assistantMessage);

    // Log assistant text if any
    if (assistantMessage.content && assistantMessage.content.trim()) {
      await onLog("stdout", `${assistantMessage.content}\n`);
    }

    // Check for tool calls
    const toolCalls = assistantMessage.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // No tool calls — model responded with text only, treat as done
      await onLog("stderr", "[ollama] No tool calls in response, finishing\n");
      finishSummary = assistantMessage.content?.trim() || "Heartbeat complete";
      break;
    }

    // Execute each tool call and collect results
    for (const toolCall of toolCalls) {
      const fnName = toolCall.function.name;
      let args: Record<string, unknown>;
      try {
        args =
          typeof toolCall.function.arguments === "string"
            ? (JSON.parse(toolCall.function.arguments) as Record<string, unknown>)
            : (toolCall.function.arguments as Record<string, unknown>);
      } catch {
        args = {};
      }

      if (fnName === "finish") {
        finishSummary = typeof args.summary === "string" ? args.summary : "Done";
        await onLog("stdout", `[finish] ${finishSummary}\n`);
        // Push a tool result and break
        messages.push({
          role: "tool",
          content: JSON.stringify({ ok: true }),
        });
        turns = maxTurns; // signal exit
        break;
      }

      if (fnName === "call_paperclip_api") {
        const method = typeof args.method === "string" ? args.method.toUpperCase() : "GET";
        const path = typeof args.path === "string" ? args.path : "";
        const body = args.body && typeof args.body === "object" ? (args.body as Record<string, unknown>) : undefined;

        await onLog("stderr", `[ollama] API call: ${method} ${path}\n`);

        let toolResult: string;
        try {
          const result = await callPaperclipApi(apiUrl, token, runId, method, path, body);
          await onLog("stderr", `[ollama] API response: ${result.status}\n`);
          toolResult = JSON.stringify({ status: result.status, data: result.data });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await onLog("stderr", `[ollama] API error: ${msg}\n`);
          toolResult = JSON.stringify({ error: msg });
        }

        messages.push({
          role: "tool",
          content: toolResult,
        });
      } else {
        // Unknown tool — return an error result
        await onLog("stderr", `[ollama] Unknown tool: ${fnName}\n`);
        messages.push({
          role: "tool",
          content: JSON.stringify({ error: `Unknown tool: ${fnName}` }),
        });
      }
    }
  }

  if (turns >= maxTurns && !finishSummary) {
    await onLog("stderr", `[ollama] Reached max turns (${maxTurns})\n`);
    finishSummary = `Reached maximum turns (${maxTurns})`;
  }

  await onLog("stderr", `[ollama] Heartbeat complete. Summary: ${finishSummary}\n`);

  return {
    exitCode: 0,
    signal: null,
    timedOut,
    summary: finishSummary || undefined,
    provider: "ollama",
    biller: "ollama",
    model,
    billingType: "fixed",
    costUsd: 0,
    ...(inputTokens > 0 || outputTokens > 0
      ? { usage: { inputTokens, outputTokens } }
      : {}),
  };
}
