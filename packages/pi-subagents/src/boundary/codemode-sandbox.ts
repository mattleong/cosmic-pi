import {
  CodemodeSandbox,
  type CodemodeResult,
  type CodemodeTool,
} from "@earendil-works/pi-codemode";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { WorkflowFailure } from "../workflow/model.ts";
import {
  WORKFLOW_ARGS_KEY,
  WORKFLOW_BUDGET_KEY,
  WORKFLOW_HOST_NAMESPACE,
  workflowSandboxSource,
  workflowScriptStack,
} from "../workflow/prelude.ts";

/** Matches Pi's own codemode VM memory bound. */
export const WORKFLOW_SANDBOX_MEMORY_BYTES = 256 * 1024 * 1024;
/** How long an aborted script may take to hand back its output before it is abandoned. */
const ABORT_SETTLE_TIMEOUT = "5 seconds";

/** An expected host failure, a tagged error, which the script sees as an Error with its message. */
export interface WorkflowHostFailure {
  readonly _tag: string;
  readonly message: string;
}

/** Crosses into the sandbox, which keeps only the message. */
class WorkflowHostCallError extends Schema.TaggedError<WorkflowHostCallError>()(
  "WorkflowHostCallError",
  { message: Schema.String },
) {}

/** Effects behind the script's `__workflow` namespace; see `workflow/prelude.ts`. */
export interface WorkflowSandboxHost<R> {
  /**
   * `[prompt, options]` → `{ result, outputTokens, refusal? }`: the tokens the call spent in this
   * run, and the budget error's message when the budget refused it.
   */
  readonly agent: (call: Schema.Json) => Effect.Effect<Schema.Json, WorkflowHostFailure, R>;
  readonly event: (event: Schema.Json) => Effect.Effect<void, never, R>;
  /**
   * `[reference, args]` → `{ name, body }`. It fails only for invalid `workflow()` calls, such as a
   * reference that doesn't load or args that don't match the nested workflow's `meta.args`.
   */
  readonly load: (call: Schema.Json) => Effect.Effect<Schema.Json, WorkflowHostFailure, R>;
}

export type WorkflowSandboxOutcome =
  | {
      readonly _tag: "Completed";
      readonly value: Schema.Json;
      readonly output: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "Failed";
      readonly kind: "script" | "timeout" | "aborted" | "sandbox";
      readonly failure: WorkflowFailure;
      readonly output: ReadonlyArray<string>;
    };

const decodeValue = Schema.decodeUnknownOption(Schema.Json);

const textOutput = (result: CodemodeResult): ReadonlyArray<string> =>
  result.output.flatMap((item) => (item.type === "text" ? [item.text] : []));

const sandboxOutcome = (result: CodemodeResult): WorkflowSandboxOutcome => {
  const output = textOutput(result);
  if (result.ok)
    return {
      _tag: "Completed",
      // The sandbox JSON round-trips return values; undefined becomes null.
      value: Option.getOrElse(decodeValue(result.value ?? null), () => null),
      output,
    };
  const { kind, name, message, stack } = result.error;
  const scriptStack = stack === undefined ? undefined : workflowScriptStack(stack);
  return {
    _tag: "Failed",
    kind,
    failure: {
      message,
      ...(name !== undefined && { name }),
      ...(scriptStack !== undefined && { stack: scriptStack }),
    },
    output,
  };
};

/** An aborted script that never handed back its output. */
const abandoned: WorkflowSandboxOutcome = {
  _tag: "Failed",
  kind: "aborted",
  failure: { message: "The workflow script was stopped." },
  output: [],
};

/**
 * Runs one workflow script in a fresh QuickJS worker. Host calls run as fibers of the caller's
 * scope: a call's own abort (script finished, sandbox aborted) interrupts it, and closing the
 * scope interrupts and joins every call still running, so their finalizers settle before the
 * caller observes the scope closed.
 *
 * When `abort` completes, the script is aborted and the run returns its `aborted` outcome with
 * the text output it produced. Interrupting the run instead discards that output. `budget` is
 * the script's `budget.total`.
 */
export const runWorkflowSandbox = <R>(
  body: string,
  args: Schema.Json,
  host: WorkflowSandboxHost<R>,
  abort: Effect.Effect<void>,
  budget: number | undefined,
): Effect.Effect<WorkflowSandboxOutcome, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const run = yield* FiberSet.makeRuntimePromise<R>();
    const member = (
      name: string,
      call: (input: Schema.Json) => Effect.Effect<Schema.Json | void, WorkflowHostFailure, R>,
      spread = false,
    ): CodemodeTool => ({
      name: `${WORKFLOW_HOST_NAMESPACE}.${name}`,
      spread,
      // Decoded synchronously, so a call's own first step runs while the sandbox issues it and
      // host calls start in the order the script made them.
      execute: (input, context) =>
        run(
          Effect.suspend(() =>
            Option.match(decodeValue(input), {
              onNone: () =>
                Effect.fail(
                  new WorkflowHostCallError({
                    message: `${name}() arguments must be JSON values.`,
                  }),
                ),
              onSome: call,
            }),
          ).pipe(
            Effect.mapError((failure) => new WorkflowHostCallError({ message: failure.message })),
          ),
          { signal: context.signal },
        ),
    });
    const sandbox = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new CodemodeSandbox({
            timeoutMs: Number.POSITIVE_INFINITY,
            memoryLimitBytes: WORKFLOW_SANDBOX_MEMORY_BYTES,
            globals: [
              member("agent", host.agent, true),
              member("event", host.event),
              member("load", host.load, true),
            ],
          }),
      ),
      // Closing waits for every execution's worker to exit, so it is bounded like the abort.
      (opened) =>
        Effect.promise(() => opened.close()).pipe(
          Effect.timeoutOption(ABORT_SETTLE_TIMEOUT),
          Effect.asVoid,
        ),
    );
    // Only a sandbox the run already closed refuses to execute; that run was stopped.
    const execution = Effect.tryPromise((signal) =>
      sandbox.execute(workflowSandboxSource(body), {
        signal,
        store: {
          [WORKFLOW_ARGS_KEY]: args,
          ...(budget !== undefined && { [WORKFLOW_BUDGET_KEY]: budget }),
        },
      }),
    ).pipe(
      Effect.map(sandboxOutcome),
      Effect.orElseSucceed(() => abandoned),
    );
    // Closing the sandbox aborts the script, which then settles with its output. The timeouts
    // here and on the scope's release only bound a worker that never exits, so the run still
    // finishes, records its end and reports.
    const aborted = abort.pipe(
      Effect.andThen(
        Effect.promise(() => sandbox.close()).pipe(Effect.timeoutOption(ABORT_SETTLE_TIMEOUT)),
      ),
      Effect.andThen(Effect.sleep(ABORT_SETTLE_TIMEOUT)),
      Effect.as(abandoned),
    );
    return yield* Effect.raceFirst(execution, aborted);
  });
