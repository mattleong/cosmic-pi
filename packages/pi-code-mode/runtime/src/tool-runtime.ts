import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { schemaFailureFacts, type DiagnosticFacts } from "./diagnostic-facts.js";
import type { RuntimeFailure } from "./failure.js";
import { type InterpreterValue, ToolReference } from "./interpreter/model.js";
import { observeHost, runHost, ToolError } from "./tool-error.js";
import { copyArguments, copyIn } from "./tool-runtime-data.js";
import { ToolRuntimeError } from "./tool-runtime-error.js";
import { decodeInput as decodeToolInput, decodeOutput as decodeToolOutput } from "./tool-schema.js";
import { makeSearchTool, type SearchEntry } from "./tool-search.js";
import {
  type HostTools,
  isDefinition,
  namespaceKeys,
  reservedNamespace,
  resolve,
  type ToolPathKind,
  toolPathKind,
} from "./tool-tree.js";

/** A tool refusal names the tool the runtime invoked, unless the host already did. */
const attribute = <A, R>(
  effect: Effect.Effect<A, ToolError, R>,
  tool: string,
): Effect.Effect<A, ToolError, R> =>
  Effect.mapError(effect, (error) =>
    error.tool !== undefined
      ? error
      : new ToolError({
          message: error.message,
          tool,
          ...(error.cause !== undefined && { cause: error.cause }),
        }),
  );

/** A schema failure on one line; multi-line issue text would split the diagnostic. */
const schemaFailureLine = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");

export type Services<Tools> = ServicesOf<Tools, []>;

type ServicesOf<Tools, Depth extends ReadonlyArray<unknown>> = Depth["length"] extends 8
  ? never
  : Tools extends (...args: Array<unknown>) => Effect.Effect<unknown, unknown, infer R>
    ? R
    : Tools extends {
          readonly _tag: "CodeModeTool";
          readonly run: <Input>(input: Input) => Effect.Effect<unknown, unknown, infer R>;
        }
      ? R
      : Tools extends object
        ? string extends keyof Tools
          ? ServicesOf<Tools[string], [...Depth, unknown]>
          : ServicesOf<Tools[keyof Tools], [...Depth, unknown]>
        : never;

/** Minimal audit record retained for each admitted tool call. */
export type ToolCall = {
  readonly name: string;
};

/** Full lifecycle event for one eagerly forked tool call. */
export type ToolCallLifecycleEvent =
  | {
      readonly id: number;
      readonly name: string;
      readonly status: "queued";
    }
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
      /** Whether this call acquired a concurrency permit before terminal settlement. */
      readonly started: boolean;
      /** Wall-clock time from queue admission through terminal settlement. */
      readonly durationMs: number;
      readonly queueDurationMs: number;
      /** The failed call's normalized, model-safe diagnostic; absent otherwise. */
      readonly failure?: {
        readonly kind: string;
        readonly message: string;
        readonly facts?: DiagnosticFacts;
      };
    };

/** Decoded tool call observed immediately before tool execution. */
export type ToolCallStarted = {
  readonly index: number;
  /** Correlates this admitted call with `onToolCallLifecycle`, when that hook is enabled. */
  readonly lifecycleId?: number;
  readonly name: string;
  readonly input: unknown;
};

/** Completed tool call observed immediately after tool execution settles. */
export type ToolCallEnded = {
  readonly index: number;
  /** Correlates this admitted call with `onToolCallLifecycle`, when that hook is enabled. */
  readonly lifecycleId?: number;
  readonly name: string;
  readonly input: unknown;
  readonly durationMs: number;
  readonly outcome: "success" | "failure";
  /** Model-safe failure message; present only when `outcome` is `"failure"`. */
  readonly message?: string;
};

/** Non-throwing observation hooks fired around each admitted tool call. */
export type ToolCallHooks<R = never> = {
  readonly onToolCallLifecycle?:
    | ((event: ToolCallLifecycleEvent) => Effect.Effect<void, never, R>)
    | undefined;
  readonly onToolCallStart?: ((call: ToolCallStarted) => Effect.Effect<void, never, R>) | undefined;
  readonly onToolCallEnd?: ((call: ToolCallEnded) => Effect.Effect<void, never, R>) | undefined;
};

/** A tool call that passed admission and holds one slot of the call limit. */
export interface AdmittedCall<R> {
  /** Records the call and runs the tool. Runs at most once. */
  readonly run: Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  /** Returns the limit slot of a call that will never run. */
  readonly withdraw: () => void;
}

/**
 * Admits one tool call: resolves the path, copies and decodes its input, and reserves a slot
 * of the call limit. Refusals fail here, before the call waits for a concurrency permit.
 */
export type AdmitTool<R> = (
  path: ReadonlyArray<string>,
  args: ReadonlyArray<InterpreterValue>,
  lifecycleId?: number,
) => Effect.Effect<AdmittedCall<R>, RuntimeFailure, R>;

export type ToolRuntime<R = never> = {
  readonly root: ToolReference;
  readonly calls: Array<ToolCall>;
  readonly admit: AdmitTool<R>;
  /** Enumerable namespace/tool names at one node of the callable tool tree; see `namespaceKeys`. */
  readonly keys: (path: ReadonlyArray<string>) => ReadonlyArray<string>;
  /** Whether a path names a tool, a namespace, or nothing, for `typeof` and `in`. */
  readonly kind: (path: ReadonlyArray<string>) => ToolPathKind;
};

export const make = <R>(
  tools: HostTools<R>,
  /** Undefined means unlimited tool calls. */
  maxToolCalls: number | undefined,
  searchIndex: ReadonlyArray<SearchEntry>,
  hooks?: ToolCallHooks<R>,
): ToolRuntime<R> => {
  const calls: Array<ToolCall> = [];
  const callableTools = {
    ...tools,
    [reservedNamespace]: { search: makeSearchTool(searchIndex) },
  };

  // Wraps the settling portion of a tool call so onToolCallEnd observes success and failure
  // symmetrically. Interruption (e.g. the execution timeout) fires neither outcome.
  const observeEnd = <A, E>(
    effect: Effect.Effect<A, E, R>,
    call: ToolCallStarted,
  ): Effect.Effect<A, E, R> => {
    const onEnd = hooks?.onToolCallEnd;
    if (onEnd === undefined) return effect;
    return Effect.flatMap(Clock.currentTimeMillis, (startedAt) =>
      effect.pipe(
        Effect.tap(() =>
          Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
            observeHost(() =>
              onEnd({ ...call, durationMs: endedAt - startedAt, outcome: "success" }),
            ),
          ),
        ),
        Effect.tapError((error) => {
          const message =
            error instanceof ToolError || error instanceof ToolRuntimeError
              ? error.message
              : "Tool execution failed";
          return Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
            observeHost(() =>
              onEnd({
                ...call,
                durationMs: endedAt - startedAt,
                outcome: "failure",
                message,
              }),
            ),
          );
        }),
      ),
    );
  };

  // The tool already ran; a result the program cannot hold still names the data limit it hit.
  const decodeOutput = <Value>(value: Value, name: string) =>
    Effect.try({
      try: () => copyIn(value, `Result from tool '${name}'`),
      catch: (cause) =>
        new ToolRuntimeError(
          "InvalidToolOutput",
          cause instanceof ToolRuntimeError
            ? `${cause.message} The tool ran, but its result was not returned to the program.`
            : `Invalid output from tool '${name}'.`,
          [],
          { tool: name },
        ),
    });

  // Calls that ran plus admitted calls still waiting for a concurrency permit.
  let reserved = 0;
  const reserveCall = (): void => {
    if (maxToolCalls !== undefined && reserved >= maxToolCalls) {
      throw new ToolRuntimeError(
        "ToolCallLimitExceeded",
        `Execution exceeded its tool-call limit of ${maxToolCalls}.`,
        [],
        { limit: maxToolCalls },
      );
    }
    reserved += 1;
  };

  return {
    root: new ToolReference([]),
    calls,
    keys: (path) => namespaceKeys(callableTools, path),
    kind: (path) => toolPathKind(callableTools, path),
    admit: (path, args, lifecycleId) =>
      Effect.sync(() => {
        const name = path.join(".");
        const externalArgs = copyArguments(args, `Arguments for tool '${name}'`);
        const tool = resolve(callableTools, path);
        let input: unknown = externalArgs;
        if (isDefinition(tool)) {
          if (externalArgs.length !== 1)
            throw new ToolRuntimeError(
              "InvalidToolInput",
              `Tool '${name}' expects exactly one input object.`,
              [],
              { tool: name, toolIssue: "arity" },
            );
          try {
            input = decodeToolInput(tool, externalArgs[0]);
          } catch (cause) {
            throw new ToolRuntimeError(
              "InvalidToolInput",
              `Invalid input for tool '${name}': ${schemaFailureLine(cause)}`,
              [],
              { tool: name, toolIssue: "schema", ...schemaFailureFacts(cause) },
            );
          }
        }
        reserveCall();
        let settled = false;
        const record = Effect.sync(() => {
          settled = true;
          calls.push({ name });
          const baseCall = { index: calls.length - 1, name, input };
          return lifecycleId === undefined ? baseCall : { ...baseCall, lifecycleId };
        });
        const execute = isDefinition(tool)
          ? Effect.gen(function* () {
              const raw = yield* attribute(runHost(Effect.suspend(() => tool.run(input))), name);
              const result = yield* Effect.try({
                try: () => decodeToolOutput(tool, raw),
                catch: () =>
                  new ToolRuntimeError(
                    "InvalidToolOutput",
                    `Invalid output from tool '${name}'.`,
                    [],
                    {
                      tool: name,
                    },
                  ),
              });
              return yield* decodeOutput(result, name);
            })
          : Effect.gen(function* () {
              return yield* decodeOutput(
                yield* attribute(runHost(Effect.suspend(() => tool(...externalArgs))), name),
                name,
              );
            });
        const onStart = hooks?.onToolCallStart;
        return {
          run: Effect.flatMap(record, (call) =>
            Effect.andThen(
              onStart === undefined ? Effect.void : observeHost(() => onStart(call)),
              observeEnd(execute, call),
            ),
          ),
          withdraw: () => {
            if (settled) return;
            settled = true;
            reserved -= 1;
          },
        } satisfies AdmittedCall<R>;
      }),
  };
};

export * as ToolRuntime from "./tool-runtime.js";
