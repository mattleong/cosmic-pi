import type { CustomAgent } from "../profiles/agents.ts";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import type { CompactAnimationScheduler } from "pi-code-previews";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import type { SubagentToolPresentation } from "../boundary/host-activity-widget.ts";
import type { SubagentSessionEnvironment } from "../boundary/host-profile-resolution.ts";
import type { SubagentBackendRegistry } from "../backend/service.ts";
import type { SubagentProfileService } from "../profiles/service.ts";
import {
  codedFailure,
  invalidRequest,
  subagentErrorCode,
  type InvalidSubagentRequestError,
  type SubagentError,
} from "../run/errors.ts";
import {
  isParentActionRequiredRun,
  type StartSubagentRequest,
  type SubagentControlExpectation,
  type SubagentRunView,
} from "../run/model.ts";
import { MAX_LIFECYCLE_TARGET_RUNS, MAX_TARGET_RUNS } from "../run/limits.ts";
import {
  SubagentService,
  type SubagentHeldStarts,
  type SubagentRunObservation,
} from "../run/service.ts";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";
import { executeStartBatch, resolveRecordedLaunch } from "./execute-start.ts";
import { presentSubagentResult } from "./execute-result.ts";
import { awaitContract, startContract, lifecycleContract } from "./contract.ts";
import { attentionRecoveryText } from "./format.ts";
import {
  awaitExecutionFor,
  awaitResultText,
  awaitWithinTimeout,
  observeAwaitInterruption,
  type AwaitEnding,
  type AwaitExecution,
} from "./execute-await.ts";
import { executeModelsAction } from "./execute-models.ts";
import { executeWorkspaceAction } from "./execute-workspace.ts";
import type { SubagentActionFailure } from "./model.ts";
import {
  awaitTimeoutSeconds,
  awaitUntil,
  subagentToolAction,
  type SubagentLifecycleInput,
  type SubagentToolAction,
  type SubagentToolInput,
} from "./schema.ts";

export interface SubagentToolRuntime {
  readonly scheduleAnimation?: CompactAnimationScheduler | undefined;
  readonly environment: SubagentSessionEnvironment;
  /** The root's configured agents, which its start schema lists; nested children omit them. */
  readonly agents?: ReadonlyArray<CustomAgent> | undefined;
  readonly proxyCall?:
    | ((
        input: SubagentToolInput,
        signal: AbortSignal | undefined,
        onInterruption?: () => void,
      ) => Promise<AgentToolResult<unknown>>)
    | undefined;
  readonly startUiTicker?: ((intervalMs: number, tick: () => void) => () => void) | undefined;
  readonly toolPresentation?: SubagentToolPresentation | undefined;
  /** The signal the user's next message aborts; ends root awaits so the parent can read it. */
  readonly userInput?: (() => AbortSignal) | undefined;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, SubagentService | SubagentProfileService | SubagentBackendRegistry>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

const forEachOutcome = <R>(
  ids: ReadonlyArray<string>,
  operation: (id: string) => Effect.Effect<SubagentRunView, SubagentError, R>,
) =>
  Effect.forEach(
    ids,
    (id) =>
      operation(id).pipe(
        Effect.match({
          onSuccess: (run) => ({ runId: id, run }) as const,
          onFailure: (error) =>
            ({
              runId: id,
              failure: {
                id,
                message: error.message,
                code: subagentErrorCode(error),
              } satisfies SubagentActionFailure,
            }) as const,
        }),
      ),
    { concurrency: 8 },
  ).pipe(
    Effect.map((outcomes) => {
      const [runs, actionFailures] = Arr.partition(outcomes, (outcome) =>
        "run" in outcome ? Result.succeed(outcome.run) : Result.fail(outcome.failure),
      );
      return { outcomes, runs, actionFailures };
    }),
  );

// Runs asking this caller a question appear beside the awaited hierarchy.
const withQuestionRuns = (
  contextRuns: ReadonlyArray<SubagentRunView>,
  questions: ReadonlyArray<SubagentRunView>,
): ReadonlyArray<SubagentRunView> => {
  const shown = new Set(Arr.map(contextRuns, (run) => run.id));
  return [...contextRuns, ...Arr.filter(questions, (run) => !shown.has(run.id))];
};

type AwaitToolInput = SubagentToolInput<typeof SUBAGENT_TOOL_NAME.await>;

const requiredTargetIds = (
  action: SubagentToolAction,
  runIds: ReadonlyArray<string>,
  maximum: number,
): Effect.Effect<ReadonlyArray<string>, InvalidSubagentRequestError> => {
  const ids = Arr.map(runIds, (id) => Str.trim(id));
  if (ids.length === 0)
    return Effect.fail(
      invalidRequest("run_ids_required", `${action} requires at least one run ID.`),
    );
  if (Arr.some(ids, (id) => !id))
    return Effect.fail(invalidRequest("run_id_invalid", "Subagent target IDs must be non-empty."));
  const unique = [...new Set(ids)];
  if (unique.length > maximum)
    return Effect.fail(
      invalidRequest("too_many_run_ids", `Subagent ${action} accepts at most ${maximum} targets.`),
    );
  return Effect.succeed(unique);
};

export const executeSubagentActionEffect = Effect.fn("SubagentTools.execute")(function* (
  pi: ExtensionAPI,
  environment: SubagentToolRuntime["environment"],
  input: SubagentToolInput,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ctx: ExtensionContext,
  callerRunId?: string,
  awaitExecution?: AwaitExecution,
  scripted: boolean = false,
  expected?: SubagentControlExpectation,
): Effect.fn.Return<
  AgentToolResult<unknown>,
  SubagentError,
  SubagentService | SubagentProfileService | SubagentBackendRegistry
> {
  if (input.tool === SUBAGENT_TOOL_NAME.models) {
    const parentContext =
      callerRunId && !environment.parentContext
        ? (yield* SubagentService.use((service) => service.captureLaunchParent(callerRunId)))
            .parentContext
        : environment.parentContext;
    return yield* executeModelsAction(input.args, pi, ctx, parentContext);
  }
  // Only the root adopts orphans, so only its revisions resolve a recorded launch.
  if (input.tool === SUBAGENT_TOOL_NAME.workspace) {
    if (callerRunId) return yield* executeWorkspaceAction(input.args, callerRunId);
    const services = yield* Effect.context<SubagentProfileService | SubagentBackendRegistry>();
    return yield* executeWorkspaceAction(input.args, callerRunId, (launch, task) =>
      resolveRecordedLaunch(pi, ctx, environment, launch, task).pipe(
        Effect.provideContext(services),
      ),
    );
  }

  const action = subagentToolAction(input);
  const service = yield* SubagentService;
  const launchEnvironment =
    callerRunId && !environment.parentContext && input.tool === SUBAGENT_TOOL_NAME.start
      ? { ...environment, ...(yield* service.captureLaunchParent(callerRunId)) }
      : environment;
  const authorize = (ids: ReadonlyArray<string>) =>
    callerRunId ? service.authorizeTargets(callerRunId, ids) : Effect.void;
  const startOwned = (starts: SubagentHeldStarts, request: StartSubagentRequest) =>
    callerRunId
      ? starts.startSessionOwnedFrom(callerRunId, request)
      : scripted
        ? starts.startScriptSessionOwned(request)
        : starts.startSessionOwned(request);
  // Every awaited run's block fits, so the result delivers every claimed report.
  const completeObservations = Effect.fn("SubagentTools.completeObservations")(function* (
    state: AwaitExecution,
    args: AwaitToolInput["args"],
    observations: ReadonlyArray<SubagentRunObservation>,
    questions: ReadonlyArray<SubagentRunView> = [],
  ) {
    const runs = Arr.map(observations, (observation) => observation.run);
    const attention = [...runs, ...questions];
    const attentionRequired = Arr.some(attention, isParentActionRequiredRun);
    if (scripted && attentionRequired)
      return yield* invalidRequest(
        "scripted_parent_attention_required",
        `Subagents need parent attention\n\nEnd the script and handle this directly.\n\n${attentionRecoveryText(attention)}`,
      );
    const outcome = {
      runs,
      attentionRequired,
      text: awaitResultText(state.progressSummary(runs), observations, questions),
      awaitContextRuns: withQuestionRuns(state.contextRuns(), questions),
      contract: awaitContract({
        observations,
        until: awaitUntil(args),
        requestedRunIds: state.requestedIds,
        questionsElsewhere: questions.length > 0,
      }),
    };
    const result = yield* Effect.sync(() =>
      presentSubagentResult(input, outcome, state.requestedIds),
    );
    const receipts = Arr.filterMap(observations, (observation) =>
      observation.completionReceipt
        ? Result.succeed(observation.completionReceipt)
        : Result.failVoid,
    );
    yield* Effect.sync(() => state.markDeliveryAttempt(Arr.map(receipts, (receipt) => receipt.id)));
    yield* service.consumeCompletions(receipts);
    return result;
  });
  const executeLifecycle = Effect.fn("SubagentTools.lifecycle")(function* (
    args: SubagentLifecycleInput,
  ) {
    if (scripted && args.action !== "stop")
      return yield* invalidRequest(
        "scripted_lifecycle_not_supported",
        "Codemode scripts support lifecycle stop only. Hand interrupt decisions back to the parent agent.",
      );
    const ids = yield* requiredTargetIds(action, args.runIds, MAX_LIFECYCLE_TARGET_RUNS);
    yield* authorize(ids);
    const result = yield* forEachOutcome(ids, (id) =>
      args.action === "interrupt" ? service.interrupt(id, expected) : service.stop(id, expected),
    );
    return yield* Effect.sync(() =>
      presentSubagentResult(input, {
        ...result,
        contract: lifecycleContract(args.action, result.outcomes),
      }),
    );
  }, Effect.mapError(codedFailure));
  const executeAwait = Effect.fn("SubagentTools.await")(function* (args: AwaitToolInput["args"]) {
    const until = awaitUntil(args);
    const state = awaitExecution ?? awaitExecutionFor(args.runIds, until, onUpdate);
    const ids = yield* requiredTargetIds(action, args.runIds, MAX_TARGET_RUNS);
    yield* authorize(ids);
    return yield* service.withAwaitTerminalObservations(
      ids,
      until,
      state.update,
      (observations, questions) => completeObservations(state, args, observations, questions),
      callerRunId,
    );
  }, Effect.mapError(codedFailure));

  switch (input.tool) {
    case SUBAGENT_TOOL_NAME.start: {
      const args = input.args;
      // The result reports each launch that failed after admission, so no notice repeats it.
      return yield* service.withStartFailureHold((starts) =>
        executeStartBatch({
          agents: args.agents,
          pi,
          ctx,
          environment: launchEnvironment,
          startOwned: (request) => startOwned(starts, request),
          onUpdate,
          readOnly: scripted,
        }).pipe(
          Effect.map((result) =>
            presentSubagentResult(input, {
              ...result,
              contract: startContract(args.agents, result.startOutcomes),
            }),
          ),
        ),
      );
    }
    case SUBAGENT_TOOL_NAME.await:
      return yield* executeAwait(input.args);
    case SUBAGENT_TOOL_NAME.lifecycle:
      return yield* executeLifecycle(input.args);
  }
  return Fn.absurd<never>(input);
});

/**
 * A root wait ends at its timeout, the host's abort, or the user's next message, exactly like a
 * cancellation; children keep running. The timeout runs on the effect's clock and settles as a
 * result; the signals interrupt the run, which the await state records.
 */
const executeRootAwait = (
  pi: ExtensionAPI,
  runtime: SubagentToolRuntime,
  input: AwaitToolInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ctx: ExtensionContext,
  scripted: boolean,
): Promise<AgentToolResult<unknown>> => {
  const state = awaitExecutionFor(input.args.runIds, awaitUntil(input.args), onUpdate);
  const ended = (ending: AwaitEnding) => {
    const result = state.cancelled(false, ending);
    invokeHostCallback(() => onUpdate?.(result), undefined);
    return result;
  };
  const wait = executeSubagentActionEffect(
    pi,
    runtime.environment,
    input,
    onUpdate,
    ctx,
    undefined,
    state,
    scripted,
  );
  const timeoutSeconds = awaitTimeoutSeconds(input.args);
  const bounded =
    timeoutSeconds === undefined
      ? wait
      : awaitWithinTimeout(wait, timeoutSeconds).pipe(
          Effect.flatMap(
            Result.match({
              onSuccess: Effect.succeed,
              onFailure: (ending) => Effect.sync(() => ended(ending)),
            }),
          ),
        );
  const userInput = runtime.userInput?.();
  const endings = Arr.filter([signal, userInput], Predicate.isNotUndefined);
  return runtime
    .run(
      observeAwaitInterruption(bounded, state.markInterrupted),
      endings.length > 1 ? AbortSignal.any(endings) : endings[0],
    )
    .catch((cause: unknown) => {
      if (!state.wasInterrupted()) throw cause;
      return ended(
        signal?.aborted !== true && userInput?.aborted === true
          ? { kind: "user_input" }
          : { kind: "cancelled" },
      );
    });
};

/**
 * A nested wait runs in the root, so only the abort signal reaches it; the root's completion-claim
 * cleanup after the abort is unconfirmed here.
 */
const executeProxiedAwait = (
  proxyCall: NonNullable<SubagentToolRuntime["proxyCall"]>,
  input: AwaitToolInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
): Promise<AgentToolResult<unknown>> => {
  const state = awaitExecutionFor(input.args.runIds, awaitUntil(input.args), onUpdate);
  const timeoutSeconds = awaitTimeoutSeconds(input.args);
  const timeout =
    timeoutSeconds === undefined ? undefined : AbortSignal.timeout(timeoutSeconds * 1000);
  const endings = Arr.filter([signal, timeout], Predicate.isNotUndefined);
  const waitSignal = endings.length > 1 ? AbortSignal.any(endings) : endings[0];
  return proxyCall(input, waitSignal, state.markInterrupted).catch((cause: unknown) => {
    if (!state.wasInterrupted()) throw cause;
    const ending: AwaitEnding =
      signal?.aborted !== true && timeout?.aborted === true && timeoutSeconds !== undefined
        ? { kind: "timed_out", seconds: timeoutSeconds }
        : { kind: "cancelled" };
    const result = state.cancelled(true, ending);
    invokeHostCallback(() => onUpdate?.(result), undefined);
    return result;
  });
};

export const executeSubagentAction = (
  pi: ExtensionAPI,
  runtime: SubagentToolRuntime,
  input: SubagentToolInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ctx: ExtensionContext,
  scripted = false,
): Promise<AgentToolResult<unknown>> => {
  if (input.tool === SUBAGENT_TOOL_NAME.await)
    return runtime.proxyCall
      ? executeProxiedAwait(runtime.proxyCall, input, signal, onUpdate)
      : executeRootAwait(pi, runtime, input, signal, onUpdate, ctx, scripted);
  return runtime.proxyCall
    ? runtime.proxyCall(input, signal)
    : runtime.run(
        executeSubagentActionEffect(
          pi,
          runtime.environment,
          input,
          onUpdate,
          ctx,
          undefined,
          undefined,
          scripted,
        ),
        signal,
      );
};
