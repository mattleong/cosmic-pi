/**
 * Package-local adapters over Pi's built-in read/grep/find/ls tool definitions.
 *
 * These adapters dispatch nested Code Mode tool calls **directly** against the built-in
 * implementations. Nested calls therefore bypass Pi middleware that observes or wraps
 * top-level tool calls (tool_call events, approval wrappers, preview shells, other
 * extensions' overrides), and their filesystem authority matches the direct Pi tools —
 * including absolute paths outside the project. The `code_mode` tool description discloses
 * both properties to the model.
 */
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  type AgentToolResult,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { toolError, type ToolError } from "./codemode-runtime.ts";

export const PI_GUEST_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
export type PiGuestToolName = (typeof PI_GUEST_TOOL_NAMES)[number];

// oxlint-disable-next-line no-explicit-any -- Pi's own AnyToolDefinition shape.
type AnyToolDefinition = ToolDefinition<any, any, any>;

/** The four built-in definitions one Code Mode session dispatches against. */
export type NestedPiToolDefinitions = Readonly<Record<PiGuestToolName, AnyToolDefinition>>;

/** Live factory: current built-in definitions bound to the session working directory. */
export const makeNestedPiToolDefinitions = (cwd: string): NestedPiToolDefinitions => ({
  read: createReadToolDefinition(cwd),
  grep: createGrepToolDefinition(cwd),
  find: createFindToolDefinition(cwd),
  ls: createLsToolDefinition(cwd),
});

/** Tolerant shape of a nested `AgentToolResult` at this unknown boundary. */
const NestedToolResultSchema = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      text: Schema.optionalKey(Schema.String),
    }),
  ),
});

const decodeNestedToolResult = Schema.decodeUnknownEffect(NestedToolResultSchema);

/**
 * Deterministically converts a nested built-in `AgentToolResult` into the plain string that
 * enters the guest program. Text blocks join with a newline; any non-text block (for example
 * an image from `read`) is refused model-safely so non-JSON authority never leaks into the
 * confined program.
 */
export const nestedResultToGuestData = (
  name: PiGuestToolName,
  result: AgentToolResult<unknown>,
): Effect.Effect<string, ToolError> =>
  decodeNestedToolResult(result).pipe(
    Effect.mapError(() =>
      toolError(`Nested tool '${name}' returned an unrecognized result shape.`),
    ),
    Effect.flatMap((decoded) => {
      const blocks = decoded.content;
      const nonText = blocks.find((block) => block.type !== "text");
      if (nonText !== undefined) {
        return Effect.fail(
          toolError(
            `Nested tool '${name}' returned ${nonText.type} content, which cannot enter a ` +
              `Code Mode program. Call the top-level ${name} tool for that path instead.`,
          ),
        );
      }
      return Effect.succeed(blocks.map((block) => block.text ?? "").join("\n"));
    }),
  );

export interface NestedDispatchOptions {
  readonly definitions: NestedPiToolDefinitions;
  readonly ctx: ExtensionContext;
  /** Outer `code_mode` tool-call id; nested ids derive from it deterministically. */
  readonly toolCallId: string;
  /** Outer execute abort signal; composed with per-call Effect interruption. */
  readonly signal: AbortSignal | undefined;
}

export type NestedPiToolDispatch = (
  name: PiGuestToolName,
  input: unknown,
) => Effect.Effect<string, ToolError>;

/**
 * Dispatches one nested call against the matching built-in definition.
 *
 * The nested tool receives a composed abort signal: the outer `code_mode` execute signal
 * plus this call's own Effect interruption (runtime timeout, session replacement or
 * shutdown, outer promise interruption). `AbortSignal.any` owns the listener lifetimes, so
 * no listener outlives the composed signal. Failures surface as model-safe `ToolError`
 * refusals, which the runtime reports as `ToolFailure` diagnostics.
 */
export const makeNestedPiToolDispatch = (options: NestedDispatchOptions): NestedPiToolDispatch => {
  let nestedCalls = 0;
  return (name, input) =>
    Effect.suspend(() => {
      nestedCalls += 1;
      const callId = `${options.toolCallId}/${name}/${nestedCalls}`;
      const definition = options.definitions[name];
      return Effect.tryPromise({
        try: (interruptSignal) => {
          const composed =
            options.signal === undefined
              ? interruptSignal
              : AbortSignal.any([options.signal, interruptSignal]);
          return definition.execute(callId, input, composed, undefined, options.ctx);
        },
        catch: (error) =>
          toolError(
            `Nested tool '${name}' failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
      }).pipe(Effect.flatMap((result) => nestedResultToGuestData(name, result)));
    });
};
