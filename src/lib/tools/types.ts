// Core public types for the tool registry.

export type ToolSchema = {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
};

export type ToolResult = {
  readonly ok: boolean;
  readonly content: string;
  readonly data?: unknown;
  readonly latency_ms: number;
};

export type Tool = {
  readonly schema: ToolSchema;
  readonly dangerous: boolean;
  readonly run: (input: unknown, signal: AbortSignal) => Promise<ToolResult>;
};
