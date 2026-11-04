import type { ToolDef } from './index.js';
import { checkHandbackSource, FileValidationError, sanitizeFileBaseName } from '../image-store.js';
import { stageHandbackFile } from '../handback-files.js';

// Handback (tree-7718eb70): attach a file JARVIS created to its CURRENT reply.
// Only stages the path — agent.ts copies the bytes onto the assistant turn when
// it is persisted (see handback-files.ts), and the cockpit renders it as an
// inline download chip. Scoped to the current conversation automatically.
export const attachFile: ToolDef = {
  name: 'attach_file',
  description:
    'Attach a file from an absolute path to your current reply so Kevin can download it inline — no FTP. Max 25MB per file; call once per file. The file is copied when your reply is saved, so finish writing it first.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to the file on this machine, e.g. /home/kevin/obsidian/paperclip-wiki/outbox/report.csv.',
      },
      name: {
        type: 'string',
        description: 'Optional download name (defaults to the file\'s own name).',
      },
    },
    required: ['path'],
  },
  execute: async (args, context) => {
    const conversationId = context?.conversationId;
    if (!conversationId) {
      return { error: 'No active conversation — attach_file only works inside a cockpit conversation.' };
    }
    const filePath = typeof args.path === 'string' ? args.path.trim() : '';
    if (!filePath) return { error: 'path is required' };
    const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined;
    let size: number;
    try {
      size = checkHandbackSource(filePath);
    } catch (err) {
      return { error: err instanceof FileValidationError ? err.message : String(err) };
    }
    try {
      const count = stageHandbackFile(conversationId, { absSourcePath: filePath, name });
      const shown = sanitizeFileBaseName(name || filePath);
      return { ok: true, attached: shown, bytes: size, staged_for_this_reply: count };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
};
