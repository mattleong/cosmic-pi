/**
 * Package-local adapters over seven core Pi definitions.
 *
 * These adapters deliberately dispatch nested Code Mode calls directly against fresh built-in
 * definitions. Nested calls therefore bypass Pi middleware, approval/preview extensions,
 * registered overrides, and session-specific tool operations. In particular, nested bash is
 * the default local shell implementation, while bash/edit/write confer the full process,
 * network, and unrestricted filesystem authority of the local Pi process. The `code_mode`
 * description discloses that contract to the model.
 */
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type AgentToolResult,
  type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { invokeHostCallback } from "pi-cosmic-core";
import { formatForeignRejection } from "../tools/format.ts";
import {
  decodeReadGuestInput,
  readResultToGuestData,
  requireCompleteInputRefusal,
  type ReadGuestData,
  type ReadGuestInput,
} from "../tools/read-result.ts";
import { toolError, type ToolError } from "../engine/tool.ts";

type AnyToolDefinition = ToolDefinition<any, any, any>;
export type PiGuestToolInput = Parameters<AnyToolDefinition["execute"]>[1];

/** The built-in definitions one Code Mode session dispatches against. */
export interface NestedPiToolDefinitions {
  readonly read: AnyToolDefinition;
  readonly bash: AnyToolDefinition;
  readonly edit: AnyToolDefinition;
  readonly write: AnyToolDefinition;
  readonly grep: AnyToolDefinition;
  readonly find: AnyToolDefinition;
  readonly ls: AnyToolDefinition;
}

export type PiGuestToolName = keyof NestedPiToolDefinitions;

/** Live factory: current built-in definitions bound to the session working directory. */
export const makeNestedPiToolDefinitions = (cwd: string): NestedPiToolDefinitions => ({
  read: createReadToolDefinition(cwd),
  bash: createBashToolDefinition(cwd),
  edit: createEditToolDefinition(cwd),
  write: createWriteToolDefinition(cwd),
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
 * an image from `read`) is refused model-safely so only text crosses into the program.
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
  readonly onOperation?: (
    id: number | undefined,
    certainty: "unknown" | "completed",
    recoveryId?: string,
    isError?: boolean,
  ) => void;
  readonly onDeliveryFailure?: (invocationId: number | undefined) => void;
  readonly observationId?: (fiber: number) => number | undefined;
  readonly observe?: (
    invocationId: number | undefined,
    name: PiGuestToolName,
    input: PiGuestToolInput,
    result: AgentToolResult<unknown>,
    isError: boolean,
  ) => void;
  readonly definitions: NestedPiToolDefinitions;
  readonly ctx: ExtensionToolContext;
  /** Outer `code_mode` tool-call id; nested ids derive from it deterministically. */
  readonly toolCallId: string;
}

export type NestedPiToolDispatch = (
  name: PiGuestToolName,
  input: PiGuestToolInput,
) => Effect.Effect<ReadGuestData, ToolError>;

interface NativeReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

const toNativeReadInput = (input: ReadGuestInput): NativeReadInput => {
  const native: NativeReadInput = { path: input.path };
  if (input.offset !== undefined) native.offset = input.offset;
  if (input.limit !== undefined) native.limit = input.limit;
  return native;
};

/**
 * Dispatches one nested call against the matching built-in definition.
 *
 * The nested tool receives the interrupt signal owned by `Effect.tryPromise`. Outer execute
 * cancellation, runtime timeout, and session replacement all interrupt that Effect fiber.
 * Failures surface as model-safe `ToolError` refusals, which execution reports as
 * `ToolFailure` diagnostics.
 */
export const makeNestedPiToolDispatch = (options: NestedDispatchOptions): NestedPiToolDispatch => {
  let nestedCalls = 0;

  return (name, input) =>
    Effect.flatMap(Effect.fiberId, (fiber) =>
      Effect.suspend(() => {
        const invocationId = invokeHostCallback(() => options.observationId?.(fiber), undefined);
        const readInput = name === "read" ? decodeReadGuestInput(input) : undefined;
        if (name === "read" && readInput === undefined) {
          return Effect.fail(toolError("Nested tool 'read' received unrecognized input."));
        }
        if (readInput !== undefined) {
          const refusal = requireCompleteInputRefusal(readInput);
          if (refusal !== undefined) return Effect.fail(toolError(refusal));
        }
        nestedCalls += 1;
        const callId = `${options.toolCallId}/${name}/${nestedCalls}`;
        const definition = options.definitions[name];
        if (definition === undefined) {
          return Effect.fail(toolError(`Nested tool '${name}' is unavailable on this platform.`));
        }
        const nativeInput = readInput === undefined ? input : toNativeReadInput(readInput);
        return Effect.tryPromise((interruptSignal) => {
          invokeHostCallback(() => options.onOperation?.(invocationId, "unknown"), undefined);
          return definition.execute(callId, nativeInput, interruptSignal, undefined, options.ctx);
        }).pipe(
          Effect.mapError((error: Cause.UnknownError) => {
            invokeHostCallback(
              () => options.onOperation?.(invocationId, "completed", undefined, true),
              undefined,
            );
            const message = formatForeignRejection(error.cause);
            invokeHostCallback(
              () =>
                options.observe?.(
                  invocationId,
                  name,
                  input,
                  { content: [{ type: "text", text: message }], details: {} },
                  true,
                ),
              undefined,
            );
            return toolError(`Nested tool '${name}' failed: ${message}`);
          }),
          Effect.flatMap((result) => {
            invokeHostCallback(
              () => options.onOperation?.(invocationId, "completed", undefined, false),
              undefined,
            );
            invokeHostCallback(
              () => options.observe?.(invocationId, name, input, result, false),
              undefined,
            );
            const guestData =
              readInput === undefined
                ? nestedResultToGuestData(name, result)
                : readResultToGuestData(readInput, result);
            return guestData.pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (exit._tag === "Failure")
                    invokeHostCallback(() => options.onDeliveryFailure?.(invocationId), undefined);
                }),
              ),
            );
          }),
        );
      }),
    );
};
