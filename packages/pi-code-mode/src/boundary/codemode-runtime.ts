/**
 * The single import door for the private, vendored Code Mode runtime.
 *
 * The runtime TypeScript source ships by value under `runtime/src/` and Pi/Jiti loads it
 * directly. The computed import keeps the foreign vendored tree under its own relaxed TypeScript
 * project while this extension retains the workspace's strict compiler and Effect diagnostics.
 * This owned structural contract is intentionally limited to the surface the Pi integration uses.
 */
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

export interface ToolError {
  readonly _tag: "ToolError";
  readonly message: string;
  readonly cause?: unknown;
}

export type CodeModeToolCallLifecycleEvent =
  | { readonly id: number; readonly name: string; readonly status: "queued" }
  | {
      readonly id: number;
      readonly name: string;
      readonly status: "running";
      readonly queueDurationMs: number;
    }
  | {
      readonly id: number;
      readonly name: string;
      readonly status: "succeeded" | "failed" | "cancelled";
      readonly started: boolean;
      readonly durationMs: number;
      readonly queueDurationMs: number;
    };

export interface CodeModeDiagnostic {
  readonly kind:
    | "ParseError"
    | "UnsupportedSyntax"
    | "UnknownTool"
    | "InvalidToolInput"
    | "InvalidToolOutput"
    | "InvalidDataValue"
    | "ToolCallLimitExceeded"
    | "TimeoutExceeded"
    | "ToolFailure"
    | "ExecutionFailure";
  readonly message: string;
  readonly location?: { readonly line: number; readonly column: number };
  readonly suggestions?: ReadonlyArray<string>;
}

interface CodeModeToolCall {
  readonly name: string;
}

export interface CodeModeSuccess {
  readonly ok: true;
  readonly value: Schema.Json;
  readonly logs?: ReadonlyArray<string>;
  readonly truncated?: boolean;
  readonly toolCalls: ReadonlyArray<CodeModeToolCall>;
}

export interface CodeModeFailure {
  readonly ok: false;
  readonly error: CodeModeDiagnostic;
  readonly logs?: ReadonlyArray<string>;
  readonly truncated?: boolean;
  readonly toolCalls: ReadonlyArray<CodeModeToolCall>;
}

export type CodeModeResult = CodeModeSuccess | CodeModeFailure;

interface CodeModeExecutionLimits {
  readonly timeoutMs?: number;
  readonly maxToolCalls?: number;
  readonly maxOutputBytes?: number;
}

interface CodeModeExecuteOptions {
  readonly code: string;
  readonly tools?: Readonly<Record<string, unknown>>;
  readonly limits?: CodeModeExecutionLimits;
  readonly onToolCallLifecycle?: (
    event: CodeModeToolCallLifecycleEvent,
  ) => Effect.Effect<void, never>;
  readonly onToolCallStart?: (call: {
    readonly index: number;
    readonly lifecycleId?: number;
    readonly name: string;
    readonly input: unknown;
  }) => Effect.Effect<void, never>;
  readonly onToolCallEnd?: (call: {
    readonly index: number;
    readonly lifecycleId?: number;
    readonly name: string;
    readonly input: unknown;
    readonly durationMs: number;
    readonly outcome: "success" | "failure";
    readonly message?: string;
  }) => Effect.Effect<void, never>;
}

interface CodeModeApi {
  readonly execute: (options: CodeModeExecuteOptions) => Effect.Effect<CodeModeResult>;
  readonly make: (
    options?: Omit<CodeModeExecuteOptions, "code"> & {
      readonly discovery?: { readonly catalogBudget?: number };
    },
  ) => {
    readonly catalog: () => ReadonlyArray<{
      readonly path: string;
      readonly description: string;
      readonly signature: string;
    }>;
    readonly instructions: () => string;
    readonly execute: (code: string) => Effect.Effect<CodeModeResult>;
  };
}

interface JsonSchema {
  readonly [key: string]: unknown;
}

type ToolSchema = Schema.Decoder<unknown> | JsonSchema;
type ToolInput<Shape> = Shape extends Schema.Decoder<unknown> ? Shape["Type"] : unknown;
type ToolOutput<Shape> = Shape extends Schema.Decoder<unknown> ? Shape["Encoded"] : unknown;

interface ToolDefinition<Requirements = never> {
  readonly _tag: "CodeModeTool";
  readonly description: string;
  readonly input: ToolSchema;
  readonly output: ToolSchema | undefined;
  readonly run: (input: unknown) => Effect.Effect<unknown, unknown, Requirements>;
}

interface ToolApi {
  readonly make: <
    Input extends ToolSchema,
    Output extends ToolSchema | undefined = undefined,
    Requirements = never,
  >(options: {
    readonly description: string;
    readonly input: Input;
    readonly output?: Output;
    readonly run: (
      input: ToolInput<Input>,
    ) => Effect.Effect<ToolOutput<Output>, unknown, Requirements>;
  }) => ToolDefinition<Requirements>;
}

interface RuntimeModule {
  readonly CodeMode: CodeModeApi;
  readonly Tool: ToolApi;
  readonly ToolError: new (args: {
    readonly message: string;
    readonly cause?: unknown;
  }) => ToolError;
  readonly toolError: (message: string, cause?: unknown) => ToolError;
}

const runtimeSource: string = "../../runtime/src/index.ts";
const loaded: unknown = await import(runtimeSource);
if (typeof loaded !== "object" || loaded === null) {
  throw new Error("Code Mode runtime source did not expose a module object.");
}
const candidate = loaded as Partial<RuntimeModule>;
if (
  typeof candidate.CodeMode?.execute !== "function" ||
  typeof candidate.CodeMode.make !== "function" ||
  typeof candidate.Tool?.make !== "function" ||
  typeof candidate.ToolError !== "function" ||
  typeof candidate.toolError !== "function"
) {
  throw new Error("Code Mode runtime source is missing its required public API.");
}

export const CodeMode: CodeModeApi = candidate.CodeMode;
export const Tool: ToolApi = candidate.Tool;
export const ToolError: RuntimeModule["ToolError"] = candidate.ToolError;
export const toolError: RuntimeModule["toolError"] = candidate.toolError;
