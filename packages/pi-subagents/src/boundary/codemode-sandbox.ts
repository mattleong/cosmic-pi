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

const WORKFLOW_SANDBOX_MEMORY_BYTES = 256 * 1024 * 1024;
const ABORT_SETTLE_TIMEOUT = "5 seconds";

export interface WorkflowHostFailure {
  readonly _tag: string;
  readonly message: string;
}

class WorkflowHostCallError extends Schema.TaggedError<WorkflowHostCallError>()(
  "WorkflowHostCallError",
  { message: Schema.String },
) {}

export interface WorkflowSandboxHost<R> {
  readonly agent: (call: Schema.Json) => Effect.Effect<Schema.Json, WorkflowHostFailure, R>;
  readonly event: (event: Schema.Json) => Effect.Effect<void, never, R>;
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

const abandoned: WorkflowSandboxOutcome = {
  _tag: "Failed",
  kind: "aborted",
  failure: { message: "The workflow script was stopped." },
  output: [],
};

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
      (opened) =>
        Effect.promise(() => opened.close()).pipe(
          Effect.timeoutOption(ABORT_SETTLE_TIMEOUT),
          Effect.asVoid,
        ),
    );
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
    const aborted = abort.pipe(
      Effect.andThen(
        Effect.promise(() => sandbox.close()).pipe(Effect.timeoutOption(ABORT_SETTLE_TIMEOUT)),
      ),
      Effect.andThen(Effect.sleep(ABORT_SETTLE_TIMEOUT)),
      Effect.as(abandoned),
    );
    return yield* Effect.raceFirst(execution, aborted);
  });
