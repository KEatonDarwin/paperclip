import type { ToolDef } from './index.js';
import {
  listThreadTodos,
  createThreadTodo,
  updateThreadTodoStatus,
  updateThreadTodoContent,
  getThreadTodo,
  type ThreadTodoStatus,
} from '../thread-todos.js';

const VALID_STATUSES: ThreadTodoStatus[] = ['todo', 'doing', 'done'];

// DAR-676 cockpit. The right-hand "todos" pane of a JARVIS Command Center
// conversation renders the `thread_todos` rows for that conversation. This tool
// is how JARVIS itself populates and drives that pane in real time so Kevin can
// watch a plan take shape and stop JARVIS mid-flight if needed. Todos are scoped
// to the CURRENT conversation automatically via the tool execution context —
// JARVIS never passes a conversation id.
export const threadTodos: ToolDef = {
  name: 'thread_todos',
  description:
    "Manage the to-do checklist shown in the right-hand pane of the CURRENT cockpit conversation. Use THIS tool — not any external/session task list — to surface your working plan to Kevin live: create items when you take on multi-step work, flip them todo→doing→done as you progress, edit wording as things change. Todos are automatically scoped to the current conversation. Operations: 'list' (return this thread's todos), 'create' (add one, needs content), 'set_status' (needs todo_id + status of todo|doing|done), 'edit' (needs todo_id + content).",
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['list', 'create', 'set_status', 'edit'],
        description: 'What to do.',
      },
      content: {
        type: 'string',
        description: 'Todo text. Required for create and edit.',
      },
      todo_id: {
        type: 'number',
        description: 'Target todo id. Required for set_status and edit.',
      },
      status: {
        type: 'string',
        enum: ['todo', 'doing', 'done'],
        description: 'New status. Required for set_status.',
      },
    },
    required: ['operation'],
  },
  execute: async (args, context) => {
    const conversationId = context?.conversationId;
    if (!conversationId) {
      return { error: 'No active conversation — thread todos are only available inside a cockpit conversation.' };
    }
    const op = typeof args.operation === 'string' ? args.operation : '';

    switch (op) {
      case 'list':
        return { todos: listThreadTodos(conversationId) };

      case 'create': {
        const content = typeof args.content === 'string' ? args.content.trim() : '';
        if (!content) return { error: 'content is required to create a todo' };
        return { ok: true, todo: createThreadTodo(conversationId, content) };
      }

      case 'set_status': {
        const id = Number(args.todo_id);
        const status = (typeof args.status === 'string' ? args.status : '') as ThreadTodoStatus;
        if (!id || !VALID_STATUSES.includes(status)) {
          return { error: 'set_status needs todo_id and a status of todo, doing, or done' };
        }
        const existing = getThreadTodo(id);
        if (!existing || existing.conversation_id !== conversationId) {
          return { error: 'todo_not_found on this thread' };
        }
        return { ok: true, todo: updateThreadTodoStatus(id, status) };
      }

      case 'edit': {
        const id = Number(args.todo_id);
        const content = typeof args.content === 'string' ? args.content.trim() : '';
        if (!id || !content) return { error: 'edit needs todo_id and content' };
        const existing = getThreadTodo(id);
        if (!existing || existing.conversation_id !== conversationId) {
          return { error: 'todo_not_found on this thread' };
        }
        return { ok: true, todo: updateThreadTodoContent(id, content) };
      }

      default:
        return { error: `unknown operation: ${op || '(none)'}` };
    }
  },
};
