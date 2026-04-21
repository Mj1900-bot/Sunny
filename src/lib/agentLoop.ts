// ---------------------------------------------------------------------------
// Compatibility re-export shim.
//
// The implementation has been split into src/lib/agent/ (the directory
// module). This file re-exports the full public surface so existing callers
// that import from '../lib/agentLoop' continue to work without changes.
//
// DO NOT add logic here. Edit src/lib/agent/index.ts instead.
// ---------------------------------------------------------------------------

export {
  runAgent,
  __internal,
} from './agent/index';

export type {
  AgentStep,
  AgentRunOptions,
  AgentRunResult,
  ChatFn,
} from './agent/types';
