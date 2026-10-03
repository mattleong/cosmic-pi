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
  WORKFLOW_HOST_NAMESPACE,
  workflowSandboxSource,
} from "../workflow/prelude.ts";

/** Matches Pi's own codemode VM memory bound. */
export const WORKFLOW_SANDBOX_MEMORY_BYTES = 256 * 1024 * 1024;
/** How long an aborted script may take to hand back its output before it is abandoned. */
const ABORT_SETTLE_TIMEOUT = "5 seconds";

/** A host failure the script sees as an Error with this message. */
export interface WorkflowHostFailure {
  readonly message: string;
}

/** Crosses into the sandbox, which keeps only the message. */
class WorkflowHostCallError extends Schema.TaggedError<WorkflowHostCallError>()(
  "WorkflowHostCallError",
  { message: Schema.String },
) {}

/** Effects behind the script's `__workflow` namespace; see `workflow/prelude.ts`. */
export interface WorkflowSandboxHost<R> {
  /** `[prompt, options]` → `{ result, outputTokens }`. */
  readonly agent: (call: Schema.Json) => Effect.Effect<Schema.Json, WorkflowHostFailure, R>;
  readonly event: (event: Schema.Json) => Effect.Effect<void, never, R>;
  /** Saved-workflow reference → `{ name, body }`. */
  readonly load: (reference: Schema.Json) => Effect.Effect<Schema.Json, WorkflowHostFailure, R>;
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

const decodeJson = Schema.decodeUnknownEffect(Schema.Json);
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
  return {
    _tag: "Failed",
    kind,
    failure: {
      message,
      ...(name !== undefined && { name }),
      ...(stack !== undefined && { stack }),
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
 * the text output it produced. Interrupting the run instead discards that output.
 */
export const runWorkflowSandbox = <R>(
  body: string,
  args: Schema.Json,
  host: WorkflowSandboxHost<R>,
  abort: Effect.Effect<void> = Effect.never,
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
      execute: (input, context) =>
        run(
          decodeJson(input).pipe(
            Effect.mapError(() => ({ message: `${name}() arguments must be JSON values.` })),
            Effect.flatMap(call),
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
              member("load", host.load),
            ],
          }),
      ),
      (opened) => Effect.promise(() => opened.close()),
    );
    // Only a sandbox the run already closed refuses to execute; that run was stopped.
    const execution = Effect.tryPromise((signal) =>
      sandbox.execute(workflowSandboxSource(body), {
        signal,
        store: { [WORKFLOW_ARGS_KEY]: args },
      }),
    ).pipe(
      Effect.map(sandboxOutcome),
      Effect.orElseSucceed(() => abandoned),
    );
    // Closing the sandbox aborts the script, which then settles with its output; the timeouts
    // only bound a worker that never exits.
    const aborted = abort.pipe(
      Effect.andThen(
        Effect.promise(() => sandbox.close()).pipe(Effect.timeoutOption(ABORT_SETTLE_TIMEOUT)),
      ),
      Effect.andThen(Effect.sleep(ABORT_SETTLE_TIMEOUT)),
      Effect.as(abandoned),
    );
    return yield* Effect.raceFirst(execution, aborted);
  });
