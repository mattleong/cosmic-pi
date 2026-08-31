/**
 * The single import door for the private, vendored Code Mode runtime.
 *
 * The runtime TypeScript source ships by value under `runtime/src/` and Pi/Jiti loads it
 * directly. The computed import keeps the vendored tree under its own TypeScript project while
 * this extension retains the workspace's strict compiler and Effect diagnostics. This structural
 * contract names only fields consumed by the Pi integration.
 */
import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

export interface ToolError {
  readonly _tag: "ToolError";
  readonly message: string;
}

export type CodeModeToolCallLifecycleEvent =
  | { readonly id: number; readonly name: string; readonly status: "queued" }
  | { readonly id: number; readonly name: string; readonly status: "running" }
  | {
      readonly id: number;
      readonly name: string;
      readonly status: "succeeded" | "failed" | "cancelled";
      readonly started: boolean;
      readonly durationMs: number;
    };

export interface CodeModeDiagnostic {
  readonly kind: string;
  readonly message: string;
  readonly location?: { readonly line: number; readonly column: number };
  readonly suggestions?: ReadonlyArray<string>;
}

export interface CodeModeSuccess {
  readonly ok: true;
  readonly value: Schema.Json;
  readonly logs?: ReadonlyArray<string>;
  readonly truncated?: boolean;
}

export interface CodeModeFailure {
  readonly ok: false;
  readonly error: CodeModeDiagnostic;
  readonly logs?: ReadonlyArray<string>;
  readonly truncated?: boolean;
}

export type CodeModeResult = CodeModeSuccess | CodeModeFailure;

interface CodeModeExecutionLimits {
  readonly timeoutMs?: number;
  readonly maxToolCalls?: number;
  readonly maxOutputBytes?: number;
}

interface CodeModeExecuteOptions {
  readonly code: string;
  readonly tools?: CodeModeToolNamespace;
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
    readonly durationMs: number;
    readonly outcome: "success" | "failure";
  }) => Effect.Effect<void, never>;
}

interface CodeModeApi {
  readonly execute: (options: CodeModeExecuteOptions) => Effect.Effect<CodeModeResult>;
  readonly make: (options?: {
    readonly tools?: CodeModeToolNamespace;
    readonly discovery?: { readonly catalogBudget?: number };
  }) => { readonly instructions: () => string };
}

interface ToolDefinition {
  readonly _tag: "CodeModeTool";
}

interface CodeModeToolNamespace {
  readonly [key: string]: ToolDefinition | CodeModeToolNamespace;
}

interface ToolApi {
  readonly make: <
    Input extends Schema.Decoder<unknown>,
    Output extends Schema.Decoder<unknown> | undefined = undefined,
    Requirements = never,
  >(options: {
    readonly description: string;
    readonly input: Input;
    readonly output?: Output;
    readonly run: (
      input: Input["Type"],
    ) => Effect.Effect<
      Output extends Schema.Decoder<unknown> ? Output["Encoded"] : unknown,
      unknown,
      Requirements
    >;
  }) => ToolDefinition;
}

interface RuntimeModule {
  readonly CodeMode: CodeModeApi;
  readonly Tool: ToolApi;
  readonly toolError: (message: string) => ToolError;
}

const runtimeSource: string = "../../runtime/src/index.ts";
const loaded: unknown = await import(runtimeSource);
if (!hasObjectRuntimeType(loaded) || loaded === null) {
  throw new Error("Code Mode runtime source did not expose a module object.");
}
// SAFETY: The boundary adapter's ownership and validation checks establish this host contract before use.
const candidate = loaded as Partial<RuntimeModule>;
if (
  !Predicate.isFunction(candidate.CodeMode?.execute) ||
  !Predicate.isFunction(candidate.CodeMode.make) ||
  !Predicate.isFunction(candidate.Tool?.make) ||
  !Predicate.isFunction(candidate.toolError)
) {
  throw new Error("Code Mode runtime source is missing its required public API.");
}

export const CodeMode: CodeModeApi = candidate.CodeMode;
export const Tool: ToolApi = candidate.Tool;
export const toolError: RuntimeModule["toolError"] = candidate.toolError;
