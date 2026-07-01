export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
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
];

export const TOOL_MAP: Map<string, ToolDef> = new Map(
  ALL_TOOLS.map((t) => [t.name, t]),
);
