// Tool registry: registration, listing, and execution.
//
// Tools are registered here with a JSON-schema description, a `dangerous`
// flag (for a future ConfirmGate to gate side-effectful calls), and a `run`
// function that must honour an AbortSignal. The registry is pure-library
// scaffolding; it does not import React and does not touch the UI.
//
// Every executed call is logged to the `tool_usage` SQLite table via
// invokeSafe('tool_usage_record', …). The record happens AFTER the tool
// returns (or throws) so latency is measured end-to-end. Fire-and-forget:
// a missing Tauri backend yields null from invokeSafe and the telemetry
// call is silently dropped without touching the foreground result.

import { invokeSafe } from '../tauri';
import type { Tool, ToolResult, ToolSchema } from './types';

const registry = new Map<string, Tool>();

export const TOOLS: ReadonlyMap<string, Tool> = registry;

export function registerTool(tool: Tool): void {
  if (!tool?.schema?.name) {
    throw new Error('registerTool: tool.schema.name is required');
  }
  registry.set(tool.schema.name, tool);
}

export function listToolSchemas(): ReadonlyArray<ToolSchema> {
  return Array.from(registry.values()).map(t => t.schema);
}

export function runTool(
  name: string,
  input: unknown,
  signal: AbortSignal,
): Promise<ToolResult> {
  return executeTool(name, input, signal);
}

async function executeTool(
  name: string,
  input: unknown,
  signal: AbortSignal,
): Promise<ToolResult> {
  const started = Date.now();

  // Aborted-before-start: no tool actually ran, so don't record it. The
  // caller already paid zero cost — a telemetry row here would bias
  // success rates downward by counting calls the agent cancelled on its
  // own before they began.
  if (signal.aborted) {
    return {
      ok: false,
      content: `Tool "${name}" aborted before start`,
      latency_ms: 0,
    };
  }

  const tool = registry.get(name);
  if (!tool) {
    const result: ToolResult = {
      ok: false,
      content: `Unknown tool "${name}"`,
      latency_ms: Date.now() - started,
    };
    // Unknown-tool IS worth recording — it represents a planner
    // hallucination we want to surface in the Tools tab.
    recordUsage(name, input, result);
    return result;
  }

  try {
    const result = await tool.run(input, signal);
    if (signal.aborted) {
      const aborted: ToolResult = {
        ok: false,
        content: `Tool "${name}" aborted after completion`,
        latency_ms: Date.now() - started,
      };
      // Aborted-after-completion: the tool DID run but we're discarding
      // its output. Record as an error so the UI flags the pattern.
      recordUsage(name, input, aborted);
      return aborted;
    }
    recordUsage(name, input, result);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const thrown: ToolResult = {
      ok: false,
      content: `Tool "${name}" threw: ${message}`,
      latency_ms: Date.now() - started,
    };
    recordUsage(name, input, thrown);
    return thrown;
  }
}

/**
 * Fire-and-forget telemetry write. Never awaits from the hot path — the
 * agent loop's next step starts before the INSERT lands. A failed
 * telemetry call logs at debug and moves on; the result the caller gets
 * is unaffected.
 *
 * Also fires a parallel SecurityBus event via `security_emit_tool_call`
 * so TS-dispatched tools (voice path) land in the audit log alongside
 * Rust-side `dispatch::dispatch_tool` calls. Input is previewed +
 * redacted on the Rust side — we pass it through unchanged.
 */
function recordUsage(name: string, input: unknown, result: ToolResult): void {
  const errorMsg = result.ok
    ? null
    : result.content.length > 1024
      ? `${result.content.slice(0, 1024)}…`
      : result.content;
  const latencyMs = Math.max(0, Math.round(result.latency_ms));

  void invokeSafe('tool_usage_record', {
    toolName: name,
    ok: result.ok,
    latencyMs,
    errorMsg,
  }).catch(err => {
    // Never surface telemetry errors to the user — they're not a failure
    // of the tool call, just a book-keeping miss.
    console.debug('[tool_usage] record failed:', err);
  });

  // SecurityBus mirror — separate from tool_usage so a missing Rust
  // command (older build) or an emit failure can't break telemetry.
  void invokeSafe('security_emit_tool_call', {
    tool: name,
    input: input ?? null,
    ok: result.ok,
    latencyMs,
    agent: 'ts-runtime',
  }).catch(() => {
    // Audit-log best effort — never surface to the user.
  });
}
