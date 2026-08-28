/**
 * Package-local adapters over seven core Pi definitions plus Windows-only PowerShell.
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
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type AgentToolResult,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { formatForeignRejection } from "../tools/format.ts";
import { toolError, type ToolError } from "./codemode-runtime.ts";

type AnyToolDefinition = ToolDefinition<any, any, any>;
export type PiGuestToolInput = Parameters<AnyToolDefinition["execute"]>[1];

/** The built-in definitions one Code Mode session dispatches against. */
export interface NestedPiToolDefinitions {
  readonly read: AnyToolDefinition;
  readonly bash: AnyToolDefinition;
  /** Pi's native Windows shell tool. Omitted on other platforms. */
  readonly powershell?: AnyToolDefinition;
  readonly edit: AnyToolDefinition;
  readonly write: AnyToolDefinition;
  readonly grep: AnyToolDefinition;
  readonly find: AnyToolDefinition;
  readonly ls: AnyToolDefinition;
}

export type PiGuestToolName = keyof NestedPiToolDefinitions;

export const hasNestedPowerShell = (
  definitions: NestedPiToolDefinitions,
): definitions is NestedPiToolDefinitions & { readonly powershell: AnyToolDefinition } =>
  definitions.powershell !== undefined;

/** Live factory: current built-in definitions bound to the session working directory. */
export const makeNestedPiToolDefinitions = (
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): NestedPiToolDefinitions => {
  const portable = {
    read: createReadToolDefinition(cwd),
    bash: createBashToolDefinition(cwd),
    edit: createEditToolDefinition(cwd),
    write: createWriteToolDefinition(cwd),
    grep: createGrepToolDefinition(cwd),
    find: createFindToolDefinition(cwd),
    ls: createLsToolDefinition(cwd),
  };
  return platform === "win32"
    ? { ...portable, powershell: createPowerShellToolDefinition(cwd) }
    : portable;
};

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
}

export type NestedPiToolDispatch = (
  name: PiGuestToolName,
  input: PiGuestToolInput,
) => Effect.Effect<string, ToolError>;

interface NestedToolRejection {
  readonly _tag: "NestedToolRejection";
  readonly rejection: unknown;
}

/**
 * Dispatches one nested call against the matching built-in definition.
 *
 * The nested tool receives the interrupt signal owned by `Effect.tryPromise`. Outer execute
 * cancellation, runtime timeout, and session replacement all interrupt that Effect fiber.
 * Failures surface as model-safe `ToolError` refusals, which the runtime reports as
 * `ToolFailure` diagnostics.
 */
export const makeNestedPiToolDispatch = (options: NestedDispatchOptions): NestedPiToolDispatch => {
  let nestedCalls = 0;
  return (name, input) =>
    Effect.suspend(() => {
      nestedCalls += 1;
      const callId = `${options.toolCallId}/${name}/${nestedCalls}`;
      const definition = options.definitions[name];
      if (definition === undefined) {
        return Effect.fail(toolError(`Nested tool '${name}' is unavailable on this platform.`));
      }
      return Effect.tryPromise({
        try: (interruptSignal) =>
          definition.execute(callId, input, interruptSignal, undefined, options.ctx),
        // This object construction is total. Formatting happens after tryPromise because a
        // throwing catch mapper becomes an Effect defect in the pinned rc.111 implementation.
        catch: (rejection): NestedToolRejection => ({
          _tag: "NestedToolRejection",
          rejection,
        }),
      }).pipe(
        Effect.mapError((error) =>
          toolError(`Nested tool '${name}' failed: ${formatForeignRejection(error.rejection)}`),
        ),
        Effect.flatMap((result) => nestedResultToGuestData(name, result)),
      );
    });
};
