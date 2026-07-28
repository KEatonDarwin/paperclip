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
import { notifications } from './notifications-tool.js';
import { intakeDeploy } from './intake-deploy.js';
import { cockpitDeploy } from './cockpit-deploy.js';
import { getMemberThread } from './group-chat-tool.js';

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

export const ALL_TOOLS: ToolDef[] = [
  createIssue,
  searchIssues,
  getIssue,
  updateIssue,
  updateIssueStatus,
  addComment,
  listAgents,
  listProjects,
  getSystemHealth,
  createCalendarEvent,
  readWikiPage,
  writeWikiPage,
  listWikiPages,
  searchWiki,
  readMemory,
  writeMemory,
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
  enqueueCheckin,
  listCheckins,
  cancelCheckin,
  muteReminders,
  unmuteReminders,
  listMuted,
  createScheduledTask,
  listScheduledTasks,
  getScheduledTask,
  updateScheduledTask,
  cancelScheduledTask,
  mcpCall,
  lovableSendMessage,
  supabaseExecuteSql,
  logDecision,
  threadTodos,
  notifications,
  intakeDeploy,
  cockpitDeploy,
  getMemberThread,
].map(instrumentTool);

export const TOOL_MAP: Map<string, ToolDef> = new Map(
  ALL_TOOLS.map((t) => [t.name, t]),
);
