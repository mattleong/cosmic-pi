import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import type {
  SubagentError,
  SubagentRuntimeClosedError,
  SubagentWriterConflictError,
} from "../run/errors.ts";
import type { StartSubagentRequest, SubagentProjection } from "../run/model.ts";
import type { SubagentServiceContract } from "../run/service.ts";
import type { WorkflowSlots, WorkflowWaitOrder } from "./admission-queue.ts";
import type { WorkflowBudget } from "./budget.ts";
import { sameWorkflowWaiting, type WorkflowAgentWaiting } from "./model.ts";

export type WorkflowStartFailure = SubagentError | SubagentRuntimeClosedError;

/** What admission needs from one workflow run and its session. */
export interface WorkflowAdmissionGate {
  /** The run's slots; a call holds one while it starts and runs, never behind a writer. */
  readonly slots: WorkflowSlots;
  readonly budget: Pick<WorkflowBudget, "exhausted" | "whenExhausted" | "refuse">;
  readonly log: (level: "info" | "warning", message: string) => Effect.Effect<void>;
  readonly subagents: Pick<
    SubagentServiceContract,
    | "admissionRevision"
    | "waitForAdmissionChange"
    | "waitForRevision"
    | "queuedWriterConflict"
    | "projection"
  >;
}

/** One agent() call's launch, as admission starts it and waits for the root to admit it. */
export interface WorkflowAdmissionCall<Started, A> {
  readonly order: WorkflowWaitOrder;
  /** The call's label, as the waiting log line names it. */
  readonly label: string;
  /**
   * Resolves the launch when the call first holds a slot; the root checks that request again
   * while the call waits. A failure is the call's result.
   */
  readonly resolve: Effect.Effect<Result.Result<StartSubagentRequest, A>>;
  /**
   * Asks the root to start the agent; the attempt's scope owns the admitted run. It runs again
   * for each attempt, so it must make its start request when run, not when built.
   */
  readonly start: (
    request: StartSubagentRequest,
  ) => Effect.Effect<Started, SubagentError, Scope.Scope>;
  /** Runs an admitted agent to its result, still holding its slot. */
  readonly run: (started: Started) => Effect.Effect<A>;
  /** The call's result when its start won't be admitted, or the runtime closed while it waited. */
  readonly refused: (error: WorkflowStartFailure) => A;
  /** The call's result once the run's budget is exhausted, given the budget's refusal. */
  readonly exhausted: (refusal: string) => A;
  /** Records why the call waits; called only when the reason changes, with undefined once it doesn't. */
  readonly waiting: (reason: WorkflowAgentWaiting | undefined) => Effect.Effect<void>;
}

/** How one pass under a slot ended: the call's result, or a writer it must wait behind. */
type Pass<A> =
  | { readonly done: A }
  | {
      readonly writer: SubagentWriterConflictError;
      readonly request: StartSubagentRequest;
      /** Read before the refusal, so a release meanwhile isn't missed. */
      readonly revision: number;
    };

/** Whether a writer the user paused holds the conflict, which then never clears by itself. */
const writerPaused = (projection: SubagentProjection, runId: string): boolean =>
  projection.runs.find((run) => run.id === runId)?.state === "paused";

/** What a queued writer waits on; it can be a writer the user paused or keeps for guidance. */
const waitingLine = (label: string, conflict: SubagentWriterConflictError): string =>
  `agent "${label}" is queued behind ${conflict.activeName} (${conflict.activeId}): ${conflict.message}`;

/**
 * Starts a call and returns its result once the root admits it and it settles, or its refusal
 * result. The call first takes one of its run's slots, in call order, and resolves its launch.
 * Workflow agents have their run's slots instead of the root's direct-child slots, so the root
 * refuses a start only for reasons a slot doesn't cover. A start refused for a writer conflict
 * that clears by itself gives its slot back and waits for a release, so other agents, such as
 * readers behind a queued writer, keep starting. Once the run's budget is exhausted, every wait
 * and every start still under way ends, and the call's result is `exhausted` with the budget's
 * refusal; an admitted agent always runs on.
 */
export const admitWorkflowAgent = <Started, A>(
  gate: WorkflowAdmissionGate,
  call: WorkflowAdmissionCall<Started, A>,
): Effect.Effect<A> => {
  const { subagents, budget } = gate;
  let request: StartSubagentRequest | undefined;
  let shown: WorkflowAgentWaiting | undefined;
  let waitingOn: string | undefined;

  const show = (reason: WorkflowAgentWaiting | undefined) =>
    Effect.suspend(() => {
      if (sameWorkflowWaiting(shown, reason)) return Effect.void;
      shown = reason;
      return call.waiting(reason);
    });
  const refused = budget.refuse.pipe(Effect.map(call.exhausted));
  const refuse = refused.pipe(Effect.map((done): Pass<A> => ({ done })));

  /**
   * One start, holding the call's slot; an admitted run then runs in the start's scope. The
   * revision is read just before the start, so a release during it isn't missed by a writer
   * wait. The start is given up once the budget is exhausted, since preflight or a worktree can
   * take a while; interrupting it stops an agent already admitted.
   */
  const attempt = (resolved: StartSubagentRequest): Effect.Effect<Pass<A>> =>
    Effect.scoped(
      Effect.gen(function* () {
        const revision = yield* subagents.admissionRevision;
        const started = yield* Effect.raceFirst(
          Effect.result(call.start(resolved)).pipe(Effect.asSome),
          budget.whenExhausted.pipe(Effect.as(Option.none())),
        );
        if (Option.isNone(started)) return yield* refuse;
        const result = started.value;
        if (result._tag === "Success") return { done: yield* call.run(result.success) };
        const error = result.failure;
        return error._tag === "SubagentWriterConflictError" && error.transient === true
          ? { writer: error, request: resolved, revision }
          : { done: call.refused(error) };
      }),
    );

  /** A pass holding a slot: resolve once, check for a writer conflict cheaply, then attempt. */
  const pass: Effect.Effect<Pass<A>> = Effect.gen(function* () {
    // The call holds its slot, so it no longer waits for one.
    yield* show(undefined);
    if (yield* budget.exhausted) return yield* refuse;
    if (request === undefined) {
      const resolved = yield* call.resolve;
      if (resolved._tag === "Failure") return { done: resolved.failure };
      request = resolved.success;
    }
    const revision = yield* subagents.admissionRevision;
    const writer = yield* subagents.queuedWriterConflict(request);
    if (writer) return { writer, request, revision };
    return yield* attempt(request);
  });

  /** Logs each new writer the call waits behind, since that writer may never clear by itself. */
  const noteWriter = (conflict: SubagentWriterConflictError) =>
    Effect.suspend(() => {
      const line = waitingLine(call.label, conflict);
      if (line === waitingOn) return Effect.void;
      waitingOn = line;
      return gate.log("info", line);
    });

  /** Waits for the next projection in which the writer's paused state differs from `paused`. */
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

  /**
   * Waits behind a writer, holding no slot, until a release leaves no conflict that clears by
   * itself. The revision is read before each check, so a release during it isn't missed; the
   * reason follows the writer being paused or resumed meanwhile.
   */
  const awaitWriter = (
    pending: StartSubagentRequest,
    conflict: SubagentWriterConflictError,
    revision: number,
  ): Effect.Effect<void, SubagentRuntimeClosedError> =>
    Effect.gen(function* () {
      const projection = yield* subagents.projection;
      const paused = writerPaused(projection, conflict.activeId);
      yield* noteWriter(conflict);
      yield* show({ kind: "writer", runId: conflict.activeId, name: conflict.activeName, paused });
      return yield* Effect.raceFirst(
        subagents.waitForAdmissionChange(revision).pipe(Effect.as(true)),
        pauseChanged(conflict.activeId, paused, projection.revision).pipe(Effect.as(false)),
      );
    }).pipe(
      Effect.flatMap((released) =>
        released
          ? subagents.admissionRevision.pipe(
              Effect.flatMap((next) =>
                subagents
                  .queuedWriterConflict(pending)
                  .pipe(
                    Effect.flatMap((again) =>
                      again ? awaitWriter(pending, again, next) : show(undefined),
                    ),
                  ),
              ),
            )
          : awaitWriter(pending, conflict, revision),
      ),
    );

  const loop: Effect.Effect<A> = gate.slots
    .hold(call.order, { onWait: show({ kind: "slot" }), abort: budget.whenExhausted }, pass)
    .pipe(
      Effect.flatMap((held): Effect.Effect<A, SubagentRuntimeClosedError> => {
        if (Option.isNone(held)) return refused;
        const step = held.value;
        if ("done" in step) return Effect.succeed(step.done);
        return Effect.raceFirst(
          awaitWriter(step.request, step.writer, step.revision).pipe(Effect.as(true)),
          budget.whenExhausted.pipe(Effect.as(false)),
        ).pipe(Effect.flatMap((cleared) => (cleared ? loop : refused)));
      }),
      Effect.catch((error) => Effect.succeed(call.refused(error))),
    );
  return loop;
};
