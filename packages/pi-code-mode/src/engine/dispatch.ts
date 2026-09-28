/**
 * Pi-side dispatch of the program's tool calls: admission, the call limit, eight-way
 * concurrency, lifecycle observation, and schema decoding on both sides of each tool.
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import {
  schemaFailureFacts,
  type CodeModeDiagnostic,
  type CodeModeDiagnosticFacts,
  ToolRuntimeError,
} from "./diagnostic.ts";
import { decodeInput, decodeOutput } from "./tool-schema.ts";
import { makeSearchTool, searchIndex } from "./tool-search.ts";
import { type HostTools, reservedNamespace, resolve, toolEntries } from "./tool-tree.ts";
import { type Definition, observeHost, runHost, ToolError } from "./tool.ts";

/** Nested calls one program may run at once. */
export const TOOL_CALL_CONCURRENCY = 8;

/** Full lifecycle event for one tool call. */
export type ToolCallLifecycleEvent =
  | { readonly id: number; readonly name: string; readonly status: "queued" }
  | { readonly id: number; readonly name: string; readonly status: "running" }
  | {
      readonly id: number;
      readonly name: string;
      readonly status: "succeeded" | "failed" | "cancelled";
      /** Whether this call acquired a concurrency permit before settling. */
      readonly started: boolean;
      /** Wall-clock time from queue admission through settlement. */
      readonly durationMs: number;
      /** The failed call's diagnostic, as the program sees it; absent otherwise. */
      readonly failure?: {
        readonly kind: string;
        readonly message: string;
        readonly facts?: CodeModeDiagnosticFacts;
      };
    };

/** Decoded tool input observed immediately before the tool runs. */
export interface ToolCallStarted {
  readonly lifecycleId: number;
  readonly name: string;
  readonly input: unknown;
}

export interface ToolCallHooks<R> {
  readonly onToolCallLifecycle?:
    | ((event: ToolCallLifecycleEvent) => Effect.Effect<void, never, R>)
    | undefined;
  readonly onToolCallStart?: ((call: ToolCallStarted) => Effect.Effect<void, never, R>) | undefined;
}

/** How a call settled from the program's point of view. */
export type CallReply =
  | { readonly ok: true; readonly name: string; readonly value: unknown }
  | { readonly ok: false; readonly name: string; readonly error: CodeModeDiagnostic };

/**
 * Hands a settled call to the program. Returns the diagnostic the program received instead of
 * the value when delivery failed (for example unencodable output), or `undefined`.
 */
export type DeliverReply<R> = (
  reply: CallReply,
) => Effect.Effect<CodeModeDiagnostic | undefined, never, R>;

/** The diagnostic a program sees for a dispatcher or tool failure. */
export const callDiagnostic = (
  cause: Cause.Cause<ToolError | ToolRuntimeError>,
): CodeModeDiagnostic => {
  const error = Cause.squash(cause);
  if (error instanceof ToolRuntimeError) {
    return {
      kind: error.kind,
      message: error.message,
      ...(error.suggestions.length > 0 && { suggestions: error.suggestions }),
      ...(error.facts !== undefined && { facts: error.facts }),
    };
  }
  if (error instanceof ToolError) {
    return {
      kind: "ToolFailure",
      message: error.message,
      ...(error.tool !== undefined && { facts: { tool: error.tool } }),
    };
  }
  return { kind: "ToolFailure", message: "Tool execution failed" };
};

/** A tool refusal names the tool the dispatcher invoked, unless the host already did. */
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

interface AdmittedCall<R> {
  readonly run: Effect.Effect<unknown, ToolError | ToolRuntimeError, R>;
  /** Returns the limit slot of a call that will never run. */
  readonly withdraw: () => void;
}

export interface Dispatcher<R> {
  /** Every callable path, including Code Mode's own discovery tools. */
  readonly paths: ReadonlyArray<ReadonlyArray<string>>;
  /** Runs one call through its whole lifecycle; never fails. */
  readonly call: (
    path: ReadonlyArray<string>,
    args: ReadonlyArray<unknown>,
    deliver: DeliverReply<R>,
  ) => Effect.Effect<void, never, R>;
}

export const makeDispatcher = <R>(options: {
  readonly tools: HostTools<R>;
  /** Undefined means unlimited tool calls. */
  readonly maxToolCalls: number | undefined;
  readonly hooks: ToolCallHooks<R>;
}): Dispatcher<R> => {
  const callable: HostTools<R> = {
    ...options.tools,
    [reservedNamespace]: { search: makeSearchTool(searchIndex(options.tools)) },
  };
  const permits = Semaphore.makeUnsafe(TOOL_CALL_CONCURRENCY);
  const { onToolCallLifecycle, onToolCallStart } = options.hooks;
  const emit = (event: ToolCallLifecycleEvent): Effect.Effect<void, never, R> =>
    onToolCallLifecycle === undefined ? Effect.void : observeHost(() => onToolCallLifecycle(event));
  let nextId = 0;
  // Calls that ran plus admitted calls still waiting for a permit.
  let reserved = 0;

  const admit = (
    path: ReadonlyArray<string>,
    args: ReadonlyArray<unknown>,
    lifecycleId: number,
  ): Effect.Effect<AdmittedCall<R>, ToolRuntimeError> =>
    Effect.try({
      try: () => {
        const name = path.join(".");
        const tool: Definition<R> = resolve(callable, path);
        if (args.length !== 1)
          throw new ToolRuntimeError(
            "InvalidToolInput",
            `Tool '${name}' expects exactly one input object.`,
            [],
            { tool: name, toolIssue: "arity" },
          );
        let input: unknown;
        try {
          input = decodeInput(tool, args[0]);
        } catch (cause) {
          throw new ToolRuntimeError(
            "InvalidToolInput",
            `Invalid input for tool '${name}': ${schemaFailureLine(cause)}`,
            [],
            { tool: name, toolIssue: "schema", ...schemaFailureFacts(cause) },
          );
        }
        if (options.maxToolCalls !== undefined && reserved >= options.maxToolCalls)
          throw new ToolRuntimeError(
            "ToolCallLimitExceeded",
            `Execution exceeded its tool-call limit of ${options.maxToolCalls}.`,
            [],
            { limit: options.maxToolCalls },
          );
        reserved += 1;
        let settled = false;
        const execute = Effect.gen(function* () {
          const raw = yield* attribute(runHost(Effect.suspend(() => tool.run(input))), name);
          return yield* Effect.try({
            try: () => decodeOutput(tool, raw),
            catch: () =>
              new ToolRuntimeError("InvalidToolOutput", `Invalid output from tool '${name}'.`, [], {
                tool: name,
              }),
          });
        });
        return {
          run: Effect.suspend(() => {
            settled = true;
            return onToolCallStart === undefined
              ? execute
              : Effect.andThen(
                  observeHost(() => onToolCallStart({ lifecycleId, name, input })),
                  execute,
                );
          }),
          withdraw: () => {
            if (settled) return;
            settled = true;
            reserved -= 1;
          },
        } satisfies AdmittedCall<R>;
      },
      catch: (error) =>
        error instanceof ToolRuntimeError
          ? error
          : new ToolRuntimeError("InvalidToolInput", "Tool input could not be admitted."),
    });

  const call: Dispatcher<R>["call"] = (path, args, deliver) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const id = nextId++;
        const name = path.join(".");
        const queuedAt = yield* Clock.currentTimeMillis;
        yield* emit({ id, name, status: "queued" });
        let started = false;
        const invoked = Effect.gen(function* () {
          // Refusals settle here, without waiting for a permit or reporting the call as running.
          const admitted = yield* admit(path, args, id);
          return yield* permits
            .withPermit(
              Effect.gen(function* () {
                started = true;
                yield* emit({ id, name, status: "running" });
                return yield* restore(admitted.run);
              }),
            )
            .pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (!started) admitted.withdraw();
                }),
              ),
            );
        });
        const exit = yield* Effect.exit(restore(invoked));
        let cancelled = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
        let failure: CodeModeDiagnostic | undefined;
        if (!cancelled) {
          const reply: CallReply = Exit.isSuccess(exit)
            ? { ok: true, name, value: exit.value }
            : { ok: false, name, error: callDiagnostic(exit.cause) };
          const delivered = yield* Effect.exit(restore(deliver(reply)));
          // Interrupted delivery leaves a completed operation whose result never arrived.
          if (Exit.isFailure(delivered)) cancelled = true;
          else failure = reply.ok ? delivered.value : reply.error;
        }
        const endedAt = yield* Clock.currentTimeMillis;
        yield* emit({
          id,
          name,
          status: cancelled ? "cancelled" : failure === undefined ? "succeeded" : "failed",
          started,
          durationMs: Math.max(0, endedAt - queuedAt),
          ...(failure !== undefined && {
            failure: {
              kind: failure.kind,
              message: failure.message,
              ...(failure.facts !== undefined && { facts: failure.facts }),
            },
          }),
        });
      }),
    );

  return {
    paths: toolEntries(callable).map(({ path }) => path),
    call,
  };
};
