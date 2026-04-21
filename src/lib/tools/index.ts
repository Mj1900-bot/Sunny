// Typed tool registry for SUNNY's agent loop.
//
// This module re-exports the public registry API and seeds the registry with
// every built-in tool as a side-effect of import. The implementation is split
// across sibling files so each concern stays small and focused:
//
//   ./types        — Tool, ToolSchema, ToolResult
//   ./parse        — input validation helpers
//   ./registry     — Map-backed registry + runTool/listToolSchemas
//   ./builtins/*   — built-in tool definitions, grouped by capability

export type { Tool, ToolResult, ToolSchema } from './types';
export { TOOLS, registerTool, listToolSchemas, runTool } from './registry';

import { registerTool } from './registry';
import {
  openAppTool,
  fsListTool,
  messagesRecentTool,
  webFetchReadableTool,
  webSearchTool,
  openclawPingTool,
  runShellTool,
  speakTool,
  getClipboardHistoryTool,
} from './builtins/core';
import {
  mouseMoveTool,
  mouseClickTool,
  mouseClickAtTool,
  mouseScrollTool,
  keyboardTypeTool,
  keyboardTapTool,
  keyboardComboTool,
} from './builtins/automation';
import {
  cursorPositionTool,
  screenSizeTool,
} from './builtins/introspection';
import {
  screenCaptureFullTool,
  screenCaptureRegionTool,
  screenCaptureActiveWindowTool,
} from './builtins/capture';
import {
  memoryAddTool,
  memoryListTool,
  memorySearchTool,
} from './builtins/memory';
import {
  schedulerListTool,
  schedulerAddTool,
  schedulerDeleteTool,
  schedulerSetEnabledTool,
  schedulerRunOnceTool,
} from './builtins/scheduler';
import {
  resolveContactTool,
  sendImessageTool,
  sendSmsTool,
  textContactTool,
  callContactTool,
  listChatsTool,
  fetchConversationTool,
} from './builtins/comms';
import {
  scanStartTool,
  scanFindingsTool,
  scanQuarantineTool,
  scanVaultListTool,
} from './builtins/scan';
import {
  spawnSubagentTool,
  spawnParallelTool,
  subagentStatusTool,
  subagentWaitTool,
  subagentWaitAllTool,
  subagentAbortTool,
  subagentListTool,
} from './builtins/delegation';
import {
  scheduleOnceTool,
  scheduleRecurringTool,
} from './builtins/daemon';

[
  openAppTool,
  fsListTool,
  messagesRecentTool,
  webFetchReadableTool,
  webSearchTool,
  openclawPingTool,
  runShellTool,
  speakTool,
  getClipboardHistoryTool,
  // Automation
  mouseMoveTool,
  mouseClickTool,
  mouseClickAtTool,
  mouseScrollTool,
  keyboardTypeTool,
  keyboardTapTool,
  keyboardComboTool,
  // Introspection
  cursorPositionTool,
  screenSizeTool,
  // Screen capture
  screenCaptureFullTool,
  screenCaptureRegionTool,
  screenCaptureActiveWindowTool,
  // Memory — names map to Rust agent tools (memory_remember / memory_recall)
  memoryAddTool,
  memoryListTool,
  memorySearchTool,
  // Scheduler — legacy surface, LLM should prefer schedule_once / schedule_recurring below
  schedulerListTool,
  schedulerAddTool,
  schedulerDeleteTool,
  schedulerSetEnabledTool,
  schedulerRunOnceTool,
  // Daemons — voice-first persistent agent runs with NL cadence parsing
  scheduleOnceTool,
  scheduleRecurringTool,
  // Comms
  resolveContactTool,
  sendImessageTool,
  sendSmsTool,
  textContactTool,
  callContactTool,
  listChatsTool,
  fetchConversationTool,
  // Scan
  scanStartTool,
  scanFindingsTool,
  scanQuarantineTool,
  scanVaultListTool,
  // Delegation — the agent can spawn helper sub-agents, in parallel.
  spawnSubagentTool,
  spawnParallelTool,
  subagentStatusTool,
  subagentWaitTool,
  subagentWaitAllTool,
  subagentAbortTool,
  subagentListTool,
].forEach(registerTool);
