import type { TranscriptEntry } from "../types";

export function parseOllamaLocalStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}
