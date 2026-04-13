import { asString, asBoolean, asNumber, parseJson } from "@paperclipai/adapter-utils/server-utils";

/**
 * Parse auggie --print --output-format json output.
 *
 * Auggie emits a single JSON line with this shape:
 * {
 *   "type": "result",
 *   "result": "<assistant response>",
 *   "is_error": false,
 *   "subtype": "success",
 *   "session_id": "<uuid>",
 *   "num_turns": 3,
 *   "request_id": "<uuid>"
 * }
 *
 * On error, is_error is true and result may contain the error message.
 */
export interface AuggieResult {
  sessionId: string | null;
  summary: string;
  isError: boolean;
  errorMessage: string | null;
  numTurns: number;
  requestId: string | null;
}

export function parseAuggieOutput(stdout: string): AuggieResult {
  let sessionId: string | null = null;
  let summary = "";
  let isError = false;
  let errorMessage: string | null = null;
  let numTurns = 0;
  let requestId: string | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type !== "result") continue;

    sessionId = asString(event.session_id, "").trim() || null;
    summary = asString(event.result, "").trim();
    isError = asBoolean(event.is_error, false);
    numTurns = asNumber(event.num_turns, 0);
    requestId = asString(event.request_id, "").trim() || null;

    if (isError) {
      errorMessage = summary || "auggie returned an error";
      summary = "";
    }
    break;
  }

  return { sessionId, summary, isError, errorMessage, numTurns, requestId };
}

export function isAuggieUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return /session\s+not\s+found|unknown\s+session|invalid\s+session|session.*expired/i.test(haystack);
}
