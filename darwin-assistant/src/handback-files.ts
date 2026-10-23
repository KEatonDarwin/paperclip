// Handback staging buffer (tree-7718eb70): the attach_file tool runs mid-turn,
// before the assistant reply exists, so its final turn_index is unknown. The
// tool stages the SOURCE PATH here; when agent.ts persists the assistant turn it
// drains the buffer and copies the bytes (saveHandbackFile) onto that turn.
//
// In-memory and per-process on purpose: tool-exec (native MCP and the text
// protocol alike) runs inside the same darwin-assistant process as the turn
// loop. A restart mid-turn drops staged entries — the turn itself is lost then
// too, so there is nothing to attach them to.

export interface StagedHandbackFile {
  absSourcePath: string;
  name?: string;
}

/** Per-conversation cap, matching the upload side's MAX_FILES_PER_MESSAGE spirit
 *  but roomier — a build can legitimately hand back a handful of artifacts. */
export const MAX_HANDBACK_FILES_PER_TURN = 10;

const staged = new Map<number, StagedHandbackFile[]>();

/** Stage a file for the current assistant reply. Returns the number now staged.
 *  Re-staging the same path replaces the earlier entry (latest name wins). */
export function stageHandbackFile(conversationId: number, file: StagedHandbackFile): number {
  const list = (staged.get(conversationId) ?? []).filter((f) => f.absSourcePath !== file.absSourcePath);
  if (list.length >= MAX_HANDBACK_FILES_PER_TURN) {
    throw new Error(`at most ${MAX_HANDBACK_FILES_PER_TURN} files can be attached to one reply`);
  }
  list.push({ absSourcePath: file.absSourcePath, ...(file.name ? { name: file.name } : {}) });
  staged.set(conversationId, list);
  return list.length;
}

/** Return every file staged for this conversation, then clear it. */
export function drainHandbackFiles(conversationId: number): StagedHandbackFile[] {
  const list = staged.get(conversationId) ?? [];
  staged.delete(conversationId);
  return list;
}
