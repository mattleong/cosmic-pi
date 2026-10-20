import type { CustomAgent } from "../profiles/agents.ts";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { absurd } from "effect/Function";
import * as Predicate from "effect/Predicate";
import type { CompactAnimationScheduler } from "pi-code-previews";
import { invokeHostCallback } from "pi-cosmic-core";
import type { SubagentToolPresentation } from "../boundary/host-activity-widget.ts";
import {
  resolveProfileRetry,
  type SubagentSessionEnvironment,
} from "../boundary/host-profile-resolution.ts";
import type { SubagentBackendRegistry } from "../backend/service.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import {
  invalidRequest,
  subagentErrorCode,
  type InvalidSubagentRequestError,
  type SubagentError,
} from "../run/errors.ts";
import {
  isParentActionRequiredRun,
  SUBAGENT_ROOT_RUN_ID,
  type StartSubagentRequest,
  type SubagentControlExpectation,
  type SubagentRunView,
} from "../run/model.ts";
import { MAX_TARGET_RUNS } from "../run/limits.ts";
import { SubagentService, type SubagentRunObservation } from "../run/service.ts";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";
import { executeStartBatch, resolveRecordedLaunch } from "./execute-start.ts";
import { presentSubagentResult, type SubagentExecutionResult } from "./execute-result.ts";
import { awaitContract, startContract, lifecycleContract } from "./contract.ts";
import { attentionRecoveryText, formatDetailedRuns, renderedCompletionReceipts } from "./format.ts";
import {
  awaitExecutionFor,
  observeAwaitInterruption,
  type AwaitEnding,
  type AwaitExecution,
} from "./execute-await.ts";
import { executeModelsAction } from "./execute-models.ts";
import { executeWorkspaceAction } from "./execute-workspace.ts";
import type { SubagentActionFailure } from "./model.ts";
import { isUncertainToolFailure } from "./outcome.ts";
import {
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
    Effect.map((outcomes) => ({
      outcomes,
      runs: outcomes.flatMap((outcome) => ("run" in outcome ? [outcome.run] : [])),
      actionFailures: outcomes.flatMap((outcome) =>
        "failure" in outcome ? [outcome.failure] : [],
      ),
    })),
  );

// Runs asking this caller a question appear beside the awaited hierarchy.
const withQuestionRuns = (
  contextRuns: ReadonlyArray<SubagentRunView>,
  questions: ReadonlyArray<SubagentRunView>,
): ReadonlyArray<SubagentRunView> => {
  const shown = new Set(contextRuns.map((run) => run.id));
  return [...contextRuns, ...questions.filter((run) => !shown.has(run.id))];
};

type AwaitedLifecycleResult = Effect.Success<ReturnType<typeof forEachOutcome>>;

const requiredTargetIds = (
  action: SubagentToolAction,
  runIds: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, InvalidSubagentRequestError> => {
  const ids = runIds.map((id) => id.trim());
  if (ids.length === 0)
    return Effect.fail(
      invalidRequest("run_ids_required", `${action} requires at least one run ID.`),
    );
  if (ids.some((id) => !id))
    return Effect.fail(invalidRequest("run_id_invalid", "Subagent target IDs must be non-empty."));
  const unique = [...new Set(ids)];
  if (unique.length > MAX_TARGET_RUNS)
    return Effect.fail(
      invalidRequest(
        "too_many_run_ids",
        `Subagent actions accept at most ${MAX_TARGET_RUNS} targets.`,
      ),
    );
  return Effect.succeed(unique);
};

export const executeSubagentActionEffect = (
  pi: ExtensionAPI,
  environment: SubagentToolRuntime["environment"],
  input: SubagentToolInput,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ctx: ExtensionContext,
  callerRunId?: string,
  awaitExecution?: AwaitExecution,
  scripted = false,
  expected?: SubagentControlExpectation,
): Effect.Effect<
  AgentToolResult<unknown>,
  SubagentError,
  SubagentService | SubagentProfileService | SubagentBackendRegistry
> => {
  if (input.tool === SUBAGENT_TOOL_NAME.models)
    return callerRunId && !environment.parentContext
      ? SubagentService.use((service) => service.captureLaunchParent(callerRunId)).pipe(
          Effect.flatMap((parent) =>
            executeModelsAction(input.args, pi, ctx, parent.parentContext),
          ),
        )
      : executeModelsAction(input.args, pi, ctx, environment.parentContext);
  // Only the root adopts orphans, so only its revisions resolve a recorded launch.
  if (input.tool === SUBAGENT_TOOL_NAME.workspace)
    return callerRunId
      ? executeWorkspaceAction(input.args, callerRunId)
      : Effect.context<SubagentProfileService | SubagentBackendRegistry>().pipe(
          Effect.flatMap((services) =>
            executeWorkspaceAction(input.args, callerRunId, (launch, task) =>
              resolveRecordedLaunch(pi, ctx, environment, launch, task).pipe(
                Effect.provideContext(services),
              ),
            ),
          ),
        );

  const action = subagentToolAction(input);
  const formatOptions = { parentCwd: environment.cwd };
  const awaitState =
    input.tool === SUBAGENT_TOOL_NAME.await
      ? (awaitExecution ?? awaitExecutionFor(input.args.runIds, input.args.until, onUpdate))
      : undefined;
  const requestedAwaitIds = awaitState?.requestedIds;
  const present = (result: SubagentExecutionResult) =>
    presentSubagentResult(input, result, requestedAwaitIds, formatOptions);
  return Effect.gen(function* () {
    const service = yield* SubagentService;
    const launchEnvironment =
      callerRunId && !environment.parentContext && input.tool === SUBAGENT_TOOL_NAME.start
        ? { ...environment, ...(yield* service.captureLaunchParent(callerRunId)) }
        : environment;
    const authorize = (ids: ReadonlyArray<string>) =>
      callerRunId ? service.authorizeTargets(callerRunId, ids) : Effect.void;
    const startOwned = (request: StartSubagentRequest) =>
      callerRunId
        ? service.startSessionOwnedFrom(callerRunId, request)
        : scripted
          ? service.startScriptSessionOwned(request)
          : service.startSessionOwned(request);
    const completeObservations = (
      observations: ReadonlyArray<SubagentRunObservation>,
      sections: ReadonlyArray<string>,
      extra: () => {
        readonly actionFailures?: ReadonlyArray<SubagentActionFailure>;
        readonly awaitContextRuns?: ReadonlyArray<SubagentRunView>;
      } = () => ({}),
      questions: ReadonlyArray<SubagentRunView> = [],
    ) =>
      Effect.gen(function* () {
        const runs = observations.map((observation) => observation.run);
        const attention = [...runs, ...questions];
        const attentionRequired = attention.some(isParentActionRequiredRun);
        if (scripted && attentionRequired)
          return yield* invalidRequest(
            "scripted_parent_attention_required",
            `Subagents need parent attention\n\nEnd the script and handle this directly.\n\n${attentionRecoveryText(attention)}`,
          );
        const prefix = [...sections, attentionRecoveryText(attention)].filter(Boolean).join("\n\n");
        const pendingIds = new Set(
          observations.flatMap((observation) =>
            observation.completionReceipt || observation.questionReceipt
              ? [observation.run.id]
              : [],
          ),
        );
        const formatted = formatDetailedRuns(
          runs,
          prefix ? `${prefix}\n\n` : "",
          formatOptions,
          pendingIds,
        );
        const additional = extra();
        const contract =
          input.tool === SUBAGENT_TOOL_NAME.await
            ? awaitContract({
                observations,
                deliveredIds: formatted.deliveredIds,
                until: input.args.until,
                requestedRunIds: requestedAwaitIds ?? [],
                questionsElsewhere: questions.length > 0,
              })
            : undefined;
        const outcome = {
          runs,
          attentionRequired,
          text: formatted.text,
          ...additional,
          ...(contract && { contract }),
        };
        const result = yield* Effect.sync(() => present(outcome));
        const receipts = renderedCompletionReceipts(observations, formatted.deliveredIds);
        awaitState?.markDeliveryAttempt(receipts.map((receipt) => receipt.id));
        yield* service.consumeCompletions(receipts);
        return { result, deliveredIds: formatted.deliveredIds };
      });
    const executeLifecycle = (args: SubagentLifecycleInput) =>
      Effect.gen(function* () {
        if (scripted && args.action !== "stop")
          return yield* invalidRequest(
            "scripted_lifecycle_not_supported",
            "Codemode scripts support lifecycle stop only. Hand retry and interrupt decisions back to the parent agent.",
          );
        const presentLifecycle = (result: AwaitedLifecycleResult) =>
          present({
            ...result,
            contract: lifecycleContract(args.action, result.outcomes),
          });
        if (args.action === "retry") {
          const ids = yield* requiredTargetIds(action, args.runIds);
          const profileService = yield* SubagentProfileService;
          const policySnapshot = yield* profileService.capture;
          yield* authorize(ids);
          return presentLifecycle(
            yield* forEachOutcome(ids, (id) => {
              let handedOff = false;
              return Effect.acquireUseRelease(
                service.claimRetryContinuation(id),
                (claim) =>
                  Effect.gen(function* () {
                    const parentId = claim.source.parentRunId;
                    const parent =
                      parentId && parentId !== SUBAGENT_ROOT_RUN_ID
                        ? yield* service.captureLaunchParent(parentId)
                        : undefined;
                    return yield* resolveProfileRetry(pi, claim, ctx, {
                      ...environment,
                      parentContext: undefined,
                      ...parent,
                    });
                  }).pipe(
                    Effect.tapError((error) =>
                      subagentErrorCode(error) === "retry_route_exhausted"
                        ? service.exhaustRetryClaim(id, claim.claimToken)
                        : isUncertainToolFailure({ code: subagentErrorCode(error) })
                          ? service.blockRetryClaim(id, claim.claimToken)
                          : Effect.void,
                    ),
                    Effect.flatMap((request) =>
                      service.startRetrySessionOwned(
                        {
                          ...request,
                          parentRunId: claim.source.parentRunId,
                          nestingPolicy: policySnapshot.effectiveConfig.nesting,
                        },
                        () => {
                          handedOff = true;
                        },
                      ),
                    ),
                  ),
                (claim) =>
                  handedOff ? Effect.void : service.releaseRetryClaim(id, claim.claimToken),
              );
            }),
          );
        }
        const ids = yield* requiredTargetIds(action, args.runIds);
        yield* authorize(ids);
        return presentLifecycle(
          yield* forEachOutcome(ids, (id) =>
            args.action === "interrupt"
              ? service.interrupt(id, expected)
              : service.stop(id, expected),
          ),
        );
      });

    switch (input.tool) {
      case SUBAGENT_TOOL_NAME.start: {
        const result = yield* executeStartBatch({
          agents: input.args.agents,
          pi,
          ctx,
          environment: launchEnvironment,
          startOwned,
          onUpdate,
          readOnly: scripted,
        });
        return present({
          ...result,
          contract: startContract(input.args.agents, result.startOutcomes),
        });
      }
      case SUBAGENT_TOOL_NAME.await: {
        const ids = yield* requiredTargetIds(action, input.args.runIds);
        yield* authorize(ids);
        const state =
          awaitState ?? (yield* Effect.die(new Error("Await execution state is missing.")));
        return yield* service
          .withAwaitTerminalObservations(
            ids,
            input.args.until,
            state.update,
            (observations, questions = []) =>
              completeObservations(
                observations,
                [state.progressText(observations.map((observation) => observation.run))],
                () => ({ awaitContextRuns: withQuestionRuns(state.contextRuns(), questions) }),
                questions,
              ),
            (outcome) => outcome.deliveredIds,
            callerRunId,
          )
          .pipe(Effect.map(({ result }) => result));
      }
      case SUBAGENT_TOOL_NAME.lifecycle:
        return yield* executeLifecycle(input.args);
    }
    return absurd<never>(input);
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
  const awaitState =
    input.tool === SUBAGENT_TOOL_NAME.await
      ? awaitExecutionFor(input.args.runIds, input.args.until, onUpdate)
      : undefined;
  const timeoutSeconds =
    input.tool === SUBAGENT_TOOL_NAME.await ? input.args.timeoutSeconds : undefined;
  // The timeout and the user's next message end only this wait, exactly like a cancellation;
  // children keep running.
  const timeout =
    timeoutSeconds === undefined ? undefined : AbortSignal.timeout(timeoutSeconds * 1000);
  const userInput =
    input.tool === SUBAGENT_TOOL_NAME.await && !runtime.proxyCall
      ? runtime.userInput?.()
      : undefined;
  const endings = [signal, timeout, userInput].filter(Predicate.isNotUndefined);
  const waitSignal = endings.length > 1 ? AbortSignal.any(endings) : endings[0];
  const executing = runtime.proxyCall
    ? runtime.proxyCall(input, waitSignal, awaitState?.markInterrupted)
    : runtime.run(
        observeAwaitInterruption(
          executeSubagentActionEffect(
            pi,
            runtime.environment,
            input,
            onUpdate,
            ctx,
            undefined,
            awaitState,
            scripted,
          ),
          awaitState?.markInterrupted,
        ),
        waitSignal,
      );
  return executing.catch((cause: unknown) => {
    if (!awaitState?.wasInterrupted()) throw cause;
    const ending: AwaitEnding =
      signal?.aborted === true
        ? { kind: "cancelled" }
        : timeout?.aborted === true && timeoutSeconds !== undefined
          ? { kind: "timed_out", seconds: timeoutSeconds }
          : userInput?.aborted === true
            ? { kind: "user_input" }
            : { kind: "cancelled" };
    const result = awaitState.cancelled(runtime.proxyCall !== undefined, ending);
    invokeHostCallback(() => onUpdate?.(result), undefined);
    return result;
  });
};
