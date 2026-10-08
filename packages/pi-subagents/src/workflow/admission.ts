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

/** One agent() call's launch, as admission starts it and waits for the root to admit it. */
interface WorkflowAdmissionCall {
  readonly order: WorkflowWaitOrder;
  /** The call's label, as the waiting log line names it. */
  readonly label: string;
  /** Who owns the admitted run, under the run id the call reserved. */
  readonly owner: OwnedRunStart;
  /**
   * Resolves the launch when the call first holds a slot; the root checks that request again
   * while the call waits. A failure is the call's result.
   */
  readonly resolve: Effect.Effect<StartSubagentRequest, InvalidSubagentRequestError>;
  /** Runs an admitted agent to its result, still holding its slot; the attempt's scope owns it. */
  readonly run: (handle: OwnedRunHandle) => Effect.Effect<WorkflowSettlement>;
  /** Records why the call waits; called only when the reason changes, with undefined once it doesn't. */
  readonly waiting: (reason: WorkflowAgentWaiting | undefined) => Effect.Effect<void>;
}

/** How one pass under a slot ended: the call's result, or a writer it must wait behind. */
type Pass =
  | { readonly done: WorkflowSettlement }
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
 * Starts a call and returns its settlement once the root admits it and it settles, or its
 * refusal. The call first takes one of its run's slots, in call order, and resolves its launch.
 * Workflow agents have their run's slots instead of the root's direct-child slots, so the root
 * refuses a start only for reasons a slot doesn't cover. A start refused for a writer conflict
 * that clears by itself gives its slot back and waits for a release, so other agents, such as
 * readers behind a queued writer, keep starting. Once the run's budget is exhausted, every wait
 * and every start still under way ends, and the call is skipped with the budget's refusal; an
 * admitted agent always runs on.
 */
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

  /**
   * One start, holding the call's slot; an admitted run then runs in the start's scope. The
   * revision is read just before the start, so a release during it isn't missed by a writer
   * wait. The start is given up once the budget is exhausted, since preflight or a worktree can
   * take a while; interrupting it stops an agent already admitted.
   */
  const attempt = (resolved: StartSubagentRequest): Effect.Effect<Pass> =>
    Effect.scoped(
      Effect.gen(function* () {
        const revision = yield* subagents.admissionRevision;
        // Each attempt asks the root again, so the start is made anew every time.
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

  /** A pass holding a slot: resolve once, check for a writer conflict cheaply, then attempt. */
  const pass: Effect.Effect<Pass, InvalidSubagentRequestError> = Effect.gen(function* () {
    // The call holds its slot, so it no longer waits for one.
    yield* show(undefined);
    if (yield* budget.exhausted) return yield* refuse;
    if (request === undefined) request = yield* call.resolve;
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
      return run.log("info", line);
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
      // The launch didn't resolve, or the runtime closed while the call waited.
      Effect.catch((error) => Effect.succeed(couldntStart(error))),
    );
  return loop;
};
