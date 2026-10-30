import type { CustomAgent } from "../profiles/agents.ts";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
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
import { NO_AGENT_MESSAGE_ARRIVALS, type AgentMessageArrivals } from "../run/message-watches.ts";
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
  type AwaitDeadline,
  type AwaitEnding,
  type AwaitExecution,
  type ProxyWaitBackstop,
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
        backstop?: ProxyWaitBackstop,
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
                ...(error.userMessage !== undefined && { userMessage: error.userMessage }),
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
  // Every awaited run's block fits, so the result delivers every claimed report. Questions and
  // agent messages that ended the wait arrive whole on their own; the result previews them.
  const completeObservations = Effect.fn("SubagentTools.completeObservations")(function* (
    state: AwaitExecution,
    args: AwaitToolInput["args"],
    observations: ReadonlyArray<SubagentRunObservation>,
    questions: ReadonlyArray<SubagentRunView>,
    messages: AgentMessageArrivals,
    deadline: AwaitDeadline | undefined,
  ) {
    // A wait its timeout already ended delivers nothing, so its claims return unconsumed.
    if (deadline?.enterDelivery() === false) return yield* Effect.interrupt;
    const runs = Arr.map(observations, (observation) => observation.run);
    const attention = [...runs, ...questions];
    const attentionRequired = Arr.some(attention, isParentActionRequiredRun);
    const now = yield* Clock.currentTimeMillis;
    if (scripted && attentionRequired)
      return yield* invalidRequest(
        "scripted_parent_attention_required",
        `Subagents need parent attention\n\nEnd the script and handle this directly.\n\n${attentionRecoveryText(attention)}`,
      );
    const outcome = {
      runs,
      attentionRequired,
      ...(messages.count > 0 && { awaitMessages: messages }),
      text: awaitResultText(state.progressSummary(runs), observations, questions, now, messages),
      awaitContextRuns: withQuestionRuns(state.contextRuns(), questions),
      contract: awaitContract({
        observations,
        until: awaitUntil(args),
        requestedRunIds: state.requestedIds,
        questionsElsewhere: questions.length > 0,
        messages,
        now,
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
  // The timeout applies here for root and nested callers alike, so the result is either the
  // delivered outcomes or a timeout whose claims were released, never a delivery cut short.
  const executeAwait = Effect.fn("SubagentTools.await")(function* (args: AwaitToolInput["args"]) {
    const until = awaitUntil(args);
    const state = awaitExecution ?? awaitExecutionFor(args.runIds, until, onUpdate);
    const ids = yield* requiredTargetIds(action, args.runIds, MAX_TARGET_RUNS);
    yield* authorize(ids);
    const wait = (deadline?: AwaitDeadline) =>
      service.withAwaitTerminalObservations(
        ids,
        until,
        state.update,
        (observations, questions = [], messages = NO_AGENT_MESSAGE_ARRIVALS) =>
          completeObservations(state, args, observations, questions, messages, deadline),
        callerRunId,
      );
    const timeoutSeconds = awaitTimeoutSeconds(args);
    if (timeoutSeconds === undefined) return yield* wait();
    const bounded = yield* awaitWithinTimeout(wait, timeoutSeconds);
    if (Result.isSuccess(bounded)) return bounded.success;
    const result = state.cancelled(yield* Clock.currentTimeMillis, false, bounded.failure);
    invokeHostCallback(() => onUpdate?.(result), undefined);
    return result;
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
 * cancellation; children keep running. The await action applies the timeout on the effect's clock
 * and settles it as a result; the signals interrupt the run, which the await state records.
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
    const result = state.cancelled(state.interruptedAt(), false, ending);
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
  const userInput = runtime.userInput?.();
  const endings = Arr.filter([signal, userInput], Predicate.isNotUndefined);
  return runtime
    .run(
      observeAwaitInterruption(wait, state.markInterrupted),
      endings.length > 1 ? AbortSignal.any(endings) : endings[0],
    )
    .catch((cause: unknown) => {
      if (!state.wasInterrupted()) throw cause;
      const ending: AwaitEnding =
        signal?.aborted !== true && userInput?.aborted === true
          ? { kind: "user_input" }
          : { kind: "cancelled" };
      return ended(ending);
    });
};

/**
 * How long past its timeout a nested wait waits for the root's answer. The root answers at the
 * timeout, so only an answer lost while the connection stays up, such as a response send whose
 * outcome was uncertain, reaches it.
 */
const NESTED_AWAIT_BACKSTOP_GRACE_SECONDS = 30;

/**
 * A nested wait runs in the root, which applies its timeout and answers with either the delivered
 * outcomes or a timeout whose claims it released. Here only the abort signal or the backstop ends
 * it, cancelling it at the root; the root's completion-claim cleanup after that cancellation is
 * unconfirmed. The root may already have delivered reports in an answer that never arrived, so
 * every requested run's report may have been delivered, and `agent_read` returns it.
 */
const executeProxiedAwait = (
  proxyCall: NonNullable<SubagentToolRuntime["proxyCall"]>,
  input: AwaitToolInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
): Promise<AgentToolResult<unknown>> => {
  const state = awaitExecutionFor(input.args.runIds, awaitUntil(input.args), onUpdate);
  // The root clamps again; sending the clamped value keeps a non-finite one off the JSON wire.
  const timeoutSeconds = awaitTimeoutSeconds(input.args);
  const { timeoutSeconds: _requested, ...args } = input.args;
  const forwarded: AwaitToolInput = {
    tool: input.tool,
    args: timeoutSeconds === undefined ? args : { ...args, timeoutSeconds },
  };
  let ending: AwaitEnding = { kind: "cancelled" };
  const backstop: ProxyWaitBackstop | undefined =
    timeoutSeconds === undefined
      ? undefined
      : {
          seconds: timeoutSeconds + NESTED_AWAIT_BACKSTOP_GRACE_SECONDS,
          onExpired: () => {
            ending = { kind: "timed_out", seconds: timeoutSeconds };
          },
        };
  // The root's clock stamps the runs, so a wait ended here names no stall signs.
  const interrupted = () => state.markInterrupted();
  return proxyCall(forwarded, signal, interrupted, backstop).catch((cause: unknown) => {
    if (!state.wasInterrupted()) throw cause;
    state.markDeliveryAttempt(state.requestedIds);
    const result = state.cancelled(
      undefined,
      true,
      signal?.aborted === true ? { kind: "cancelled" } : ending,
    );
    invokeHostCallback(() => onUpdate?.(result), undefined);
    return result;
  });
};

const NESTED_START_CANCELLED =
  "agent_start was cancelled. Runs it already started keep running, and a launch's failure may already have been delivered in the result that was lost. agent_list shows the runs, and agent_read returns each outcome.";

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
  if (input.tool === SUBAGENT_TOOL_NAME.start && runtime.proxyCall)
    return runtime.proxyCall(input, signal).catch((cause: unknown) => {
      // The root may have composed the start's result, consuming the failures it held, before
      // the cancellation reached it.
      if (signal?.aborted !== true) throw cause;
      throw new Error(NESTED_START_CANCELLED);
    });
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
