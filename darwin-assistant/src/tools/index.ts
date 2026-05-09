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
} from './shim.js';

export {
  enqueueCheckin,
  listCheckins,
  cancelCheckin,
} from './checkin.js';

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
} from './shim.js';
import {
  enqueueCheckin,
  listCheckins,
  cancelCheckin,
} from './checkin.js';

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
  enqueueCheckin,
  listCheckins,
  cancelCheckin,
];

export const TOOL_MAP: Map<string, ToolDef> = new Map(
  ALL_TOOLS.map((t) => [t.name, t]),
);
