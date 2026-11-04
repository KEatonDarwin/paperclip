// LIVE STREAM ACCUMULATOR — the thing that decides what the cockpit sees while
// a turn is still running (thinking + the reply composing live).
//
// WHY THIS FILE EXISTS (bug found 2026-10-13, Kevin: "it starts to show its
// thinking and then doesn't... it looks like the sentence is being appended to
// and it's overwriting the last part of the sentence character wise"):
//
// The old inline handler in agent.ts kept ONE accumulator for the whole
// tool-turn (`accumulatedText`, every assistant message concatenated) but
// rebuilt `fullText` PER assistant message, then compared and sliced the two
// against each other:
//
//     if (fullText.length > accumulatedText.length)
//       emit(fullText.slice(accumulatedText.length))
//
// Those are two different coordinate systems, so on any turn with more than one
// assistant message it broke in exactly two ways:
//
//   * a LATER message SHORTER than everything before it emitted nothing at all
//     — the live stream silently froze mid-turn ("starts, then doesn't"), and
//   * a LATER message LONGER than everything before it got sliced at the
//     previous total's length — chopping that message's first N characters and
//     running it into the tail of the previous sentence ("overwriting the last
//     part of the sentence character wise").
//
// The Claude CLI is spawned WITHOUT --include-partial-messages, so it never
// emits content_block_delta at all: every Claude turn went through that broken
// branch, on every multi-step turn. (Codex's adapter maps each completed
// message to a synthetic whole-text text_delta, which is why the delta path
// below must keep appending verbatim.)
//
// THE FIX: keep per-message state keyed by the message id, and only ever diff a
// message against ITS OWN already-streamed prefix. Thinking is accumulated
// separately so it can never pollute the reply text that gets persisted as a
// partial on error.
//
// SECOND FINDING (same day, probing the CLI directly): the Claude CLI REDACTS
// reasoning text. With --include-partial-messages it opens a real `thinking`
// content block and streams `thinking_delta`s, but every one carries
// `{"thinking": "", "estimated_tokens": N}` — text stripped, signature only.
// So "show Kevin the thinking" can never mean text on Claude; the honest live
// signal is that cumulative token estimate, which rises in ~50s while the model
// reasons. We surface it as its own emit kind so the cockpit can render
// "Thinking… ~N tokens" instead of an empty box. `estimated_tokens` is
// CUMULATIVE PER BLOCK (observed 50, 50, 100, 100), hence the per-index max
// below rather than a running sum of deltas. Codex, which does hand over real
// reasoning text, still flows through the text path untouched.

export type StreamEmitKind = 'text' | 'thinking' | 'thinking_progress';

export type StreamEmit =
  | { kind: 'text' | 'thinking'; delta: string }
  /** Claude redacts reasoning text; this is the cumulative token estimate. */
  | { kind: 'thinking_progress'; tokens: number };

export type StreamAccumulator = {
  /** Everything emitted as REPLY text so far this tool-turn. */
  readonly text: string;
  /** Everything emitted as THINKING so far this tool-turn. */
  readonly thinking: string;
  /** Cumulative reasoning tokens estimated this tool-turn (Claude's only
   *  thinking signal, since the text itself is redacted). */
  readonly thinkingTokens: number;
  /** Feed one raw adapter stream event; returns what to push to clients. */
  handle(event: Record<string, unknown>): StreamEmit[];
  /** Reset for a fresh attempt (session retry / compaction retry). */
  reset(): void;
};

function blockText(block: unknown, key: 'text' | 'thinking'): string {
  const b = block as Record<string, unknown> | null;
  if (!b || b.type !== key) return '';
  const v = b[key];
  return typeof v === 'string' ? v : '';
}

export function createStreamAccumulator(): StreamAccumulator {
  let text = '';
  let thinking = '';
  // Per-message buffers: what we have already streamed for the message that is
  // currently in flight. `msgId` is how we tell "more of the same message"
  // apart from "a brand new message" without ever slicing across the boundary.
  let msgId: string | null = null;
  let msgText = '';
  let msgThinking = '';
  // `sealed` = the last thing we saw for the in-flight message was its complete
  // snapshot. While it is false, deltas are still streaming a message whose id
  // we do not know yet (delta events carry no id), so the snapshot that follows
  // must be diffed against those deltas instead of resetting past them — that
  // was a real duplicate-message bug my own fixture caught.
  let sealed = true;
  // Reasoning-token accounting. `estimated_tokens` is cumulative WITHIN a
  // content block, so we keep the latest per block index and sum; finished
  // messages are rolled into `thinkingTokensDone` on the next message_start
  // because block indexes restart at 0 for every message.
  let thinkingTokensDone = 0;
  let blockTokens = new Map<number, number>();
  const tokenTotal = () => {
    let sum = thinkingTokensDone;
    for (const v of blockTokens.values()) sum += v;
    return sum;
  };

  const handle = (event: Record<string, unknown>): StreamEmit[] => {
    const out: StreamEmit[] = [];

    // ── unwrap: with --include-partial-messages the CLI nests the real
    // Anthropic stream event inside {type:"stream_event", event:{...}}.
    if (event.type === 'stream_event' && event.event && typeof event.event === 'object') {
      return handle(event.event as Record<string, unknown>);
    }

    // A new message restarts content-block indexing, so bank what the previous
    // one accumulated before the indexes are reused.
    if (event.type === 'message_start') {
      thinkingTokensDone = tokenTotal();
      blockTokens = new Map();
      return out;
    }

    // ── incremental path (codex synthetic deltas; Claude with partial
    // messages enabled) — a delta is authoritative, append it verbatim.
    if (event.type === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined;
      const isText = (delta as { type?: unknown } | undefined)?.type === 'text_delta';
      const isThinking = (delta as { type?: unknown } | undefined)?.type === 'thinking_delta';
      if ((isText || isThinking) && sealed) {
        // first delta of a new message
        msgId = null;
        msgText = '';
        msgThinking = '';
        sealed = false;
      }
      if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        text += delta.text;
        msgText += delta.text;
        out.push({ kind: 'text', delta: delta.text });
      } else if (delta?.type === 'thinking_delta') {
        // Real reasoning text (codex, or any future CLI that stops redacting).
        if (typeof delta.thinking === 'string' && delta.thinking) {
          thinking += delta.thinking;
          msgThinking += delta.thinking;
          out.push({ kind: 'thinking', delta: delta.thinking });
        }
        // Claude's redacted case: all we get is a cumulative token estimate.
        const est = delta.estimated_tokens;
        if (typeof est === 'number' && Number.isFinite(est) && est >= 0) {
          const idx = typeof event.index === 'number' ? event.index : 0;
          const before = tokenTotal();
          // max(), never overwrite-downwards: a late small value must not make
          // the progress number go backwards in Kevin's face.
          blockTokens.set(idx, Math.max(blockTokens.get(idx) ?? 0, est));
          const after = tokenTotal();
          if (after > before) out.push({ kind: 'thinking_progress', tokens: after });
        }
      }
      return out;
    }

    // ── whole-message path (the only one Claude actually uses today).
    if (event.type !== 'assistant') return out;
    const message = event.message as Record<string, unknown> | null;
    const content = message?.content;
    if (!Array.isArray(content)) return out;

    const id = typeof message?.id === 'string' && message.id ? message.id : null;
    // A new message (or an id-less event we cannot correlate) starts fresh, so
    // its text is never diffed against a PREVIOUS message's length. If deltas
    // are mid-flight (not sealed) this snapshot completes THAT message, so keep
    // the buffer and diff against it.
    if (sealed && (id === null || id !== msgId)) {
      msgText = '';
      msgThinking = '';
    }
    msgId = id;

    let fullText = '';
    let fullThinking = '';
    for (const block of content) {
      fullText += blockText(block, 'text');
      fullThinking += blockText(block, 'thinking');
    }

    // Emit only the part of THIS message we have not sent yet. startsWith keeps
    // a mid-word slice impossible: if the snapshot disagrees with what we
    // streamed (a rewritten/retried block), send the whole snapshot rather than
    // guessing a cut point.
    const thinkingRemainder = fullThinking.startsWith(msgThinking)
      ? fullThinking.slice(msgThinking.length)
      : fullThinking;
    if (thinkingRemainder) {
      thinking += thinkingRemainder;
      out.push({ kind: 'thinking', delta: thinkingRemainder });
    }
    msgThinking = fullThinking;

    const textRemainder = fullText.startsWith(msgText) ? fullText.slice(msgText.length) : fullText;
    if (textRemainder) {
      text += textRemainder;
      out.push({ kind: 'text', delta: textRemainder });
    }
    msgText = fullText;
    sealed = true;

    return out;
  };

  return {
    get text() {
      return text;
    },
    get thinking() {
      return thinking;
    },
    get thinkingTokens() {
      return tokenTotal();
    },
    handle,
    reset() {
      text = '';
      thinking = '';
      msgId = null;
      msgText = '';
      msgThinking = '';
      sealed = true;
      thinkingTokensDone = 0;
      blockTokens = new Map();
    },
  };
}
