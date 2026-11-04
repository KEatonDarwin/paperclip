import { maybeRecordToolAction, type ToolExecutionContext } from '../autonomy-ledger.js';

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context?: ToolExecutionContext) => Promise<unknown>;
}

export {
  createIssue,
  searchIssues,
  getIssue,
  updateIssue,
  updateIssueStatus,
  addComment,
  listAgents,
  listProjects,
  getSystemHealth,
} from './paperclip.js';

export { createCalendarEvent } from './calendar.js';

export {
  readWikiPage,
  writeWikiPage,
  listWikiPages,
  searchWiki,
  readMemory,
  writeMemory,
} from './wiki.js';

export {
  listShimTasks,
  createShimTask,
  updateShimTask,
  listShimProjects,
  createShimProject,
  updateShimProject,
  listShimFridge,
  createShimFridgeItem,
  listFocusSessions,
  startFocusSession,
  stopFocusSession,
  shimDeployStatus,
  shimDeploySwitch,
  shimDeployApprove,
  shimDeployReject,
} from './shim.js';

export {
  enqueueCheckin,
  listCheckins,
  cancelCheckin,
} from './checkin.js';

export {
  muteReminders,
  unmuteReminders,
  listMuted,
} from './mute.js';

export {
  createScheduledTask,
  listScheduledTasks,
  getScheduledTask,
  updateScheduledTask,
  cancelScheduledTask,
} from './scheduled-tasks.js';

export { mcpCall, lovableSendMessage, supabaseExecuteSql } from './mcp.js';

export { logDecision } from './decisions.js';

import {
  createIssue,
  searchIssues,
  getIssue,
  updateIssue,
  updateIssueStatus,
  addComment,
  listAgents,
  listProjects,
  getSystemHealth,
} from './paperclip.js';
import { createCalendarEvent } from './calendar.js';
import {
  readWikiPage,
  writeWikiPage,
  listWikiPages,
  searchWiki,
  readMemory,
  writeMemory,
} from './wiki.js';
import {
  listShimTasks,
  createShimTask,
  updateShimTask,
  listShimProjects,
  createShimProject,
  updateShimProject,
  listShimFridge,
  createShimFridgeItem,
  listFocusSessions,
  startFocusSession,
  stopFocusSession,
  shimDeployStatus,
  shimDeploySwitch,
  shimDeployApprove,
  shimDeployReject,
} from './shim.js';
import {
  enqueueCheckin,
  listCheckins,
  cancelCheckin,
} from './checkin.js';
import {
  muteReminders,
  unmuteReminders,
  listMuted,
} from './mute.js';
import {
  createScheduledTask,
  listScheduledTasks,
  getScheduledTask,
  updateScheduledTask,
  cancelScheduledTask,
} from './scheduled-tasks.js';
import { mcpCall, lovableSendMessage, supabaseExecuteSql } from './mcp.js';
import { logDecision } from './decisions.js';
import { threadTodos } from './thread-todos-tool.js';
import { threadLinks } from './thread-links-tool.js';
import { attachFile } from './attach-file-tool.js';
import { hopper } from './hopper-tool.js';
import { workstreams } from './workstreams-tool.js';
import { smartTodos } from './smart-todos-tool.js';
import { workbench } from './workbench-tool.js';
import { notifications } from './notifications-tool.js';
import { intakeDeploy } from './intake-deploy.js';
import { cockpitDeploy } from './cockpit-deploy.js';
import { getMemberThread } from './group-chat-tool.js';
import { findChats, readChat } from './chat-search-tool.js';
import { goals } from './goals-tool.js';
import { deployControl } from './deploy-control.js';
// Side-effect of importing the tool: night-shift.ts registers the paused-tree
// provider + the autopilot stand-down probe and starts its driver.
import { nightShift } from './night-shift-tool.js';
import { throttle } from './throttle-tool.js';
import { workSwitch } from './work-switch-tool.js';
import { health } from './health-tool.js';
import { SPAWN_CHAT_TOOLS } from './spawn-chat-tool.js';

function instrumentTool(tool: ToolDef): ToolDef {
  return {
    ...tool,
    execute: async (args, context) => {
      const result = await tool.execute(args, context);
      maybeRecordToolAction(tool.name, args, result, context);
      return result;
    },
  };
}

// Retired tools (lean/prompt-diet, 2026-10-17). Paperclip the issue tracker was
// mothballed 2026-09-24 and SHIM was dropped 2026-10-10, but all 24 of these
// tool definitions were still shipped to the model on every fresh prompt
// (~25KB of schema text). They are off the menu AND out of TOOL_MAP so a call
// can't reach a dead service. The code is untouched: set
// JARVIS_RETIRED_TOOLS=on in the unit env to restore every one of them.
// The 5 scheduled-task tools are here too: they POST to the Paperclip API on
// :3100, which has been down since the mothball, so every call returned
// {"error":"fetch failed"} (one on 2026-10-16 silently lost a Nov 16 reminder)
// while the persona prompt still told the model to PREFER them. Timed
// reminders go to enqueue_checkin (Postgres, live) or create_calendar_event.
const RETIRED_TOOLS_ON = process.env.JARVIS_RETIRED_TOOLS === 'on';
export const RETIRED_TOOLS: ToolDef[] = [
  createScheduledTask,
  listScheduledTasks,
  getScheduledTask,
  updateScheduledTask,
  cancelScheduledTask,
  createIssue,
  searchIssues,
  getIssue,
  updateIssue,
  updateIssueStatus,
  addComment,
  listAgents,
  listProjects,
  getSystemHealth,
  listShimTasks,
  createShimTask,
  updateShimTask,
  listShimProjects,
  createShimProject,
  updateShimProject,
  listShimFridge,
  createShimFridgeItem,
  listFocusSessions,
  startFocusSession,
  stopFocusSession,
  shimDeployStatus,
  shimDeploySwitch,
  shimDeployApprove,
  shimDeployReject,
];

export const ALL_TOOLS: ToolDef[] = [
  ...(RETIRED_TOOLS_ON ? RETIRED_TOOLS : []),
  createCalendarEvent,
  readWikiPage,
  writeWikiPage,
  listWikiPages,
  searchWiki,
  readMemory,
  writeMemory,
  enqueueCheckin,
  listCheckins,
  cancelCheckin,
  muteReminders,
  unmuteReminders,
  listMuted,
  mcpCall,
  lovableSendMessage,
  supabaseExecuteSql,
  logDecision,
  threadTodos,
  threadLinks,
  attachFile,
  hopper,
  workstreams,
  smartTodos,
  workbench,
  notifications,
  intakeDeploy,
  cockpitDeploy,
  getMemberThread,
  findChats,
  readChat,
  goals,
  deployControl,
  nightShift,
  throttle,
  workSwitch,
  health,
  // spawn_chat + report_back (overnight 2026-10-12). Off unless the unit env
  // sets SPAWN_CHAT_ENABLED=1 — and since the MCP manifest (/internal/tools) is
  // built from ALL_TOOLS, the same flag gates mcp__jarvis__spawn_chat too.
  ...(process.env.SPAWN_CHAT_ENABLED === '1' ? SPAWN_CHAT_TOOLS : []),
].map(instrumentTool);

export const TOOL_MAP: Map<string, ToolDef> = new Map(
  ALL_TOOLS.map((t) => [t.name, t]),
);
