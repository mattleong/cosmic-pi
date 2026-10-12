import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import type {
  InvalidSubagentRequestError,
  SubagentRuntimeClosedError,
  SubagentWriterConflictError,
} from "../run/errors.ts";
import type { StartSubagentRequest, SubagentProjection } from "../run/model.ts";
import type { OwnedRunHandle, OwnedRunStart } from "../run/owned-runs.ts";
import type { SubagentServiceContract } from "../run/service.ts";
import type { WorkflowAgentRun } from "./agent.ts";
import { couldntStart, overBudgetSettlement, type WorkflowSettlement } from "./agent-settlement.ts";
import type { WorkflowWaitOrder } from "./admission-queue.ts";
import type { WorkflowAgentWaiting } from "./model.ts";

interface WorkflowAdmissionCall {
  readonly order: WorkflowWaitOrder;
  readonly label: string;
  readonly owner: OwnedRunStart;
  readonly resolve: Effect.Effect<StartSubagentRequest, InvalidSubagentRequestError>;
  readonly run: (handle: OwnedRunHandle) => Effect.Effect<WorkflowSettlement>;
  readonly waiting: (reason: WorkflowAgentWaiting | undefined) => Effect.Effect<void>;
}

type Pass =
  | { readonly done: WorkflowSettlement }
  | {
      readonly writer: SubagentWriterConflictError;
      readonly request: StartSubagentRequest;
      readonly revision: number;
    };

const writerPaused = (projection: SubagentProjection, runId: string): boolean =>
  projection.runs.find((run) => run.id === runId)?.state === "paused";

const waitingLine = (label: string, conflict: SubagentWriterConflictError): string =>
  `agent "${label}" is queued behind ${conflict.activeName} (${conflict.activeId}): ${conflict.message}`;

export const admitWorkflowAgent = (
  run: Pick<WorkflowAgentRun, "slots" | "budget" | "log">,
  subagents: Pick<
    SubagentServiceContract,
    | "startOwned"
    | "admissionRevision"
    | "waitForAdmissionChange"
    | "waitForRevision"
    | "queuedWriterConflict"
    | "projection"
  >,
  call: WorkflowAdmissionCall,
): Effect.Effect<WorkflowSettlement> => {
  const { budget } = run;
  let request: StartSubagentRequest | undefined;
  let shown: WorkflowAgentWaiting | undefined;
  let waitingOn: string | undefined;

  const show = (reason: WorkflowAgentWaiting | undefined) =>
    Effect.suspend(() => {
      if (Equal.equals(shown, reason)) return Effect.void;
      shown = reason;
      return call.waiting(reason);
    });
  const refused = budget.refuse.pipe(Effect.map(overBudgetSettlement));
  const refuse = refused.pipe(Effect.map((done): Pass => ({ done })));

  const attempt = (resolved: StartSubagentRequest): Effect.Effect<Pass> =>
    Effect.scoped(
      Effect.gen(function* () {
        const revision = yield* subagents.admissionRevision;
        const started = yield* Effect.raceFirst(
          Effect.result(subagents.startOwned(resolved, call.owner)).pipe(Effect.asSome),
          budget.whenExhausted.pipe(Effect.as(Option.none())),
        );
        if (Option.isNone(started)) return yield* refuse;
        const result = started.value;
        if (result._tag === "Success") return { done: yield* call.run(result.success) };
        const error = result.failure;
        return error._tag === "SubagentWriterConflictError" && error.transient === true
          ? { writer: error, request: resolved, revision }
          : { done: couldntStart(error) };
      }),
    );

  const pass: Effect.Effect<Pass, InvalidSubagentRequestError> = Effect.gen(function* () {
    yield* show(undefined);
    if (yield* budget.exhausted) return yield* refuse;
    request ??= yield* call.resolve;
    const revision = yield* subagents.admissionRevision;
    const writer = yield* subagents.queuedWriterConflict(request);
    if (writer) return { writer, request, revision };
    return yield* attempt(request);
  });

  const noteWriter = (conflict: SubagentWriterConflictError) =>
    Effect.suspend(() => {
      const line = waitingLine(call.label, conflict);
      if (line === waitingOn) return Effect.void;
      waitingOn = line;
      return run.log("info", line);
    });

  const pauseChanged = (
    runId: string,
    paused: boolean,
    after: number,
  ): Effect.Effect<void, SubagentRuntimeClosedError> =>
    subagents.waitForRevision(after).pipe(
      Effect.andThen(subagents.projection),
      Effect.flatMap((projection) =>
        writerPaused(projection, runId) === paused
          ? pauseChanged(runId, paused, projection.revision)
          : Effect.void,
      ),
    );

  const awaitWriter = (
    pending: StartSubagentRequest,
    first: SubagentWriterConflictError,
    firstRevision: number,
  ): Effect.Effect<void, SubagentRuntimeClosedError> =>
    Effect.gen(function* () {
      let conflict: SubagentWriterConflictError | undefined = first;
      let revision = firstRevision;
      while (conflict !== undefined) {
        const { activeId, activeName } = conflict;
        const projection = yield* subagents.projection;
        const paused = writerPaused(projection, activeId);
        yield* noteWriter(conflict);
        yield* show({ kind: "writer", runId: activeId, name: activeName, paused });
        const released = yield* Effect.raceFirst(
          subagents.waitForAdmissionChange(revision).pipe(Effect.as(true)),
          pauseChanged(activeId, paused, projection.revision).pipe(Effect.as(false)),
        );
        if (!released) continue;
        revision = yield* subagents.admissionRevision;
        conflict = yield* subagents.queuedWriterConflict(pending);
      }
      yield* show(undefined);
    });

  const loop: Effect.Effect<WorkflowSettlement> = run.slots
    .hold(call.order, { onWait: show({ kind: "slot" }), abort: budget.whenExhausted }, pass)
    .pipe(
      Effect.flatMap((held): Effect.Effect<WorkflowSettlement, SubagentRuntimeClosedError> => {
        if (Option.isNone(held)) return refused;
        const step = held.value;
        if ("done" in step) return Effect.succeed(step.done);
        return Effect.raceFirst(
          awaitWriter(step.request, step.writer, step.revision).pipe(Effect.as(true)),
          budget.whenExhausted.pipe(Effect.as(false)),
        ).pipe(Effect.flatMap((cleared) => (cleared ? loop : refused)));
      }),
      Effect.catch((error) => Effect.succeed(couldntStart(error))),
    );
  return loop;
};
