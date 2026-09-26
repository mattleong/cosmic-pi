// Pi tool execution is a Promise-shaped host boundary.
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
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
  InvalidSubagentRequestError,
  isCleanupUnconfirmed,
  isOutcomeUncertain,
  subagentErrorCode,
  type SubagentError,
} from "../run/errors.ts";
import {
  isParentActionRequiredRun,
  type StartSubagentRequest,
  type SubagentRunView,
} from "../run/model.ts";
import { MAX_TARGET_RUNS } from "../run/limits.ts";
import { SubagentService, type SubagentRunObservation } from "../run/service.ts";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";
import { executeStartBatch } from "./execute-start.ts";
import { makeAwaitDetails, makeCompactToolDetails, makeStartDetails } from "./details.ts";
import type { SubagentStartEntry } from "./details-schema.ts";
import {
  attentionRecoveryText,
  boundToolOutput,
  formatActionFailures,
  formatDetailedRuns,
  formatRun,
  formatStartResult,
  joinBoundedToolText,
  managementAcknowledgement,
  renderedCompletionReceipts,
} from "./format.ts";
import {
  makeAwaitExecution,
  observeAwaitInterruption,
  type AwaitExecution,
} from "./execute-await.ts";
import { projectRunCardTree, runTreeBranch } from "../ui/run-tree-rows.ts";
import { executeModelsAction } from "./execute-models.ts";
import { executeWorkspaceAction } from "./execute-workspace.ts";
import type { SubagentActionFailure, SubagentStartFailure } from "./model.ts";
import {
  claimsOperationError,
  lifecycleMessageError,
  subagentToolAction,
  type SubagentToolAction,
  type SubagentToolInput,
} from "./schema.ts";

export interface SubagentToolRuntime {
  readonly scheduleAnimation?: CompactAnimationScheduler | undefined;
  readonly environment: SubagentSessionEnvironment;
  /** Private nested-Pi transport. Public/root registrations leave this absent. */
  readonly proxyCall?:
    | ((
        input: SubagentToolInput,
        signal: AbortSignal | undefined,
        onInterruption?: () => void,
      ) => Promise<AgentToolResult<unknown>>)
    | undefined;
  readonly startUiTicker?: ((intervalMs: number, tick: () => void) => () => void) | undefined;
  readonly toolPresentation?: SubagentToolPresentation | undefined;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, SubagentService | SubagentProfileService | SubagentBackendRegistry>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

/** Partitions typed failures and runs in target order; defects and interruption propagate. */
const forEachOutcome = <R>(
  ids: ReadonlyArray<string>,
  operation: (id: string) => Effect.Effect<SubagentRunView, SubagentError, R>,
) =>
  Effect.partition(
    ids,
    (id) =>
      operation(id).pipe(
        Effect.mapError(
          (error): SubagentActionFailure => ({
            id,
            message: error.message,
            code: subagentErrorCode(error),
          }),
        ),
      ),
    { concurrency: 8 },
  ).pipe(Effect.map(([actionFailures, runs]) => ({ runs, actionFailures })));

const requiredField = (
  value: string,
  code: string,
  label: string,
  action: SubagentToolAction,
): Effect.Effect<string, InvalidSubagentRequestError> =>
  value.trim()
    ? Effect.succeed(value.trim())
    : Effect.fail(
        new InvalidSubagentRequestError({ code, message: `${action} requires ${label}.` }),
      );

const requiredRunId = (action: SubagentToolAction, runId: string) =>
  requiredField(runId, "run_id_required", "runId", action);

const requiredMessage = (action: SubagentToolAction, message: string) =>
  requiredField(message, "message_required", "message", action);

const requiredTargetIds = (
  action: SubagentToolAction,
  runIds: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, InvalidSubagentRequestError> => {
  const ids = runIds.map((id) => id.trim());
  if (ids.length === 0)
    return Effect.fail(
      new InvalidSubagentRequestError({
        code: "run_ids_required",
        message: `${action} requires at least one run ID.`,
      }),
    );
  if (ids.some((id) => !id))
    return Effect.fail(
      new InvalidSubagentRequestError({
        code: "run_id_invalid",
        message: "Subagent target IDs must be non-empty.",
      }),
    );
  const unique = [...new Set(ids)];
  if (unique.length > MAX_TARGET_RUNS)
    return Effect.fail(
      new InvalidSubagentRequestError({
        code: "too_many_run_ids",
        message: `Subagent actions accept at most ${MAX_TARGET_RUNS} targets.`,
      }),
    );
  return Effect.succeed(unique);
};

const joinSections = (sections: ReadonlyArray<string>): string =>
  sections.filter(Boolean).join("\n\n");

export const executeSubagentActionEffect = (
  pi: ExtensionAPI,
  environment: SubagentToolRuntime["environment"],
  input: SubagentToolInput,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ctx: ExtensionContext,
  callerRunId?: string,
  awaitExecution?: AwaitExecution,
): Effect.Effect<
  AgentToolResult<unknown>,
  SubagentError,
  SubagentService | SubagentProfileService | SubagentBackendRegistry
> => {
  if (input.tool === SUBAGENT_TOOL_NAME.models) return executeModelsAction(input.args, pi, ctx);
  if (input.tool === SUBAGENT_TOOL_NAME.workspace)
    return executeWorkspaceAction(input.args, callerRunId);

  const action = subagentToolAction(input);
  const awaitState =
    input.tool === SUBAGENT_TOOL_NAME.await
      ? (awaitExecution ?? makeAwaitExecution(input.args.runIds, input.args.until, onUpdate))
      : undefined;
  const requestedAwaitIds = awaitState?.requestedIds;
  const effect = Effect.gen(function* () {
    const service = yield* SubagentService;
    const authorize = (ids: ReadonlyArray<string>) =>
      callerRunId ? service.authorizeTargets(callerRunId, ids) : Effect.void;
    const startOwned = (request: StartSubagentRequest) =>
      callerRunId
        ? service.startSessionOwnedFrom(callerRunId, request)
        : service.startSessionOwned(request);
    const consumeCompletions = (
      observations: ReadonlyArray<SubagentRunObservation>,
      fullyRenderedIds: ReadonlySet<string>,
    ) => service.consumeCompletions(renderedCompletionReceipts(observations, fullyRenderedIds));
    // Construct the complete result inside the claim scope. A formatting or details
    // defect leaves the report available to the notification outbox.
    const completeObservations = (
      observations: ReadonlyArray<SubagentRunObservation>,
      sections: ReadonlyArray<string>,
      extra: () => {
        readonly actionFailures?: ReadonlyArray<SubagentActionFailure>;
        readonly awaitContextRuns?: ReadonlyArray<SubagentRunView>;
      } = () => ({}),
    ) =>
      Effect.gen(function* () {
        const runs = observations.map((observation) => observation.run);
        const attentionRequired = runs.some(isParentActionRequiredRun);
        const prefix = joinSections([...sections, attentionRecoveryText(runs)]);
        const formatted = formatDetailedRuns(runs, prefix ? `${prefix}\n\n` : "");
        const outcome = { runs, attentionRequired, text: formatted.text, ...extra() };
        const result = yield* Effect.sync(() => present(outcome));
        yield* consumeCompletions(observations, formatted.fullyRenderedIds);
        return { result, fullyRenderedIds: formatted.fullyRenderedIds };
      });
    const finishStatus = (ids: ReadonlyArray<string>) =>
      authorize(ids).pipe(
        Effect.andThen(
          service.withStatusObservations(ids, ({ observations, missingIds }) => {
            const actionFailures = missingIds.map(
              (id): SubagentActionFailure => ({
                id,
                code: "SubagentNotFoundError",
                message: `Subagent run not found: ${id}. Use subagent_list to refresh active run IDs.`,
              }),
            );
            return completeObservations(
              observations,
              [formatActionFailures(actionFailures)],
              () => ({
                actionFailures,
              }),
            );
          }),
        ),
        Effect.map(({ result }) => result),
      );

    switch (input.tool) {
      case SUBAGENT_TOOL_NAME.start:
        return present(
          yield* executeStartBatch({
            agents: input.args.agents,
            pi,
            ctx,
            environment,
            startOwned,
            onUpdate,
          }),
        );
      case SUBAGENT_TOOL_NAME.list:
        return present({
          runs: yield* callerRunId ? service.visibleList(callerRunId) : service.list,
        });
      case SUBAGENT_TOOL_NAME.status:
        return yield* finishStatus(yield* requiredTargetIds(action, input.args.runIds));
      case SUBAGENT_TOOL_NAME.await: {
        const ids = yield* requiredTargetIds(action, input.args.runIds);
        const until = input.args.until;
        yield* authorize(ids);
        // The tool discriminator above always constructs this call's await state.
        const state = awaitState!;
        return yield* service
          .withAwaitTerminalObservations(
            ids,
            until,
            state.update,
            (observations) =>
              completeObservations(
                observations,
                [state.progressText(observations.map((observation) => observation.run))],
                () => ({ awaitContextRuns: state.contextRuns() }),
              ),
            (outcome) => outcome.fullyRenderedIds,
          )
          .pipe(Effect.map(({ result }) => result));
      }
      case SUBAGENT_TOOL_NAME.send: {
        const ids = yield* requiredTargetIds(action, input.args.runIds);
        const message = yield* requiredMessage(action, input.args.message);
        yield* authorize(ids);
        return present(yield* forEachOutcome(ids, (id) => service.send(id, message)));
      }
      case SUBAGENT_TOOL_NAME.reply: {
        const id = yield* requiredRunId(action, input.args.runId);
        const message = yield* requiredMessage(action, input.args.message);
        yield* authorize([id]);
        return present(yield* forEachOutcome([id], (runId) => service.reply(runId, message)));
      }
      case SUBAGENT_TOOL_NAME.lifecycle: {
        const { args } = input;
        if (args.action === "retry") {
          // Retry ignores a message; only interrupt, stop, and resume reject one.
          const ids = yield* requiredTargetIds(action, args.runIds);
          const profileService = yield* SubagentProfileService;
          const policySnapshot = yield* profileService.capture;
          yield* authorize(ids);
          return present(
            yield* forEachOutcome(ids, (id) => {
              let handedOff = false;
              const operation = Effect.acquireUseRelease(
                service.claimRetryContinuation(id),
                (claim) =>
                  resolveProfileRetry(pi, claim, ctx, environment).pipe(
                    Effect.map((request) => ({
                      ...request,
                      parentRunId: claim.source.parentRunId,
                      nestingPolicy: policySnapshot.effectiveConfig.nesting,
                      nestingPolicyRevision: policySnapshot.revision,
                    })),
                    Effect.catch((error) => {
                      const finalize =
                        subagentErrorCode(error) === "retry_route_exhausted"
                          ? service.exhaustRetryClaim(id, claim.claimToken)
                          : isCleanupUnconfirmed(error) || isOutcomeUncertain(error)
                            ? service.blockRetryClaim(id, claim.claimToken)
                            : Effect.void;
                      return finalize.pipe(Effect.andThen(Effect.fail(error)));
                    }),
                    Effect.flatMap((request) =>
                      service.startRetrySessionOwned(request, () => {
                        handedOff = true;
                      }),
                    ),
                  ),
                (claim) =>
                  handedOff ? Effect.void : service.releaseRetryClaim(id, claim.claimToken),
              );
              return operation;
            }),
          );
        }
        const messageError = lifecycleMessageError(args);
        if (messageError !== undefined)
          return yield* new InvalidSubagentRequestError({
            code: "lifecycle_message_invalid",
            message: messageError,
          });
        const ids = yield* requiredTargetIds(action, args.runIds);
        yield* authorize(ids);
        return present(
          yield* forEachOutcome(ids, (id) =>
            args.action === "interrupt"
              ? service.interrupt(id)
              : args.action === "resume"
                ? service.resume(id, args.message)
                : service.stop(id),
          ),
        );
      }
      case SUBAGENT_TOOL_NAME.rename: {
        const id = yield* requiredRunId(action, input.args.runId);
        yield* authorize([id]);
        return present(
          yield* forEachOutcome([id], (runId) => service.rename(runId, input.args.name.trim())),
        );
      }
      case SUBAGENT_TOOL_NAME.claims: {
        const operation = input.args;
        const operationError = claimsOperationError(operation);
        if (operationError !== undefined)
          return yield* new InvalidSubagentRequestError({
            code: "claims_input_invalid",
            message: operationError,
          });
        if (operation.action === "list")
          return yield* finishStatus(yield* requiredTargetIds(action, operation.runIds ?? []));
        const id = yield* requiredRunId(action, operation.runId ?? "");
        yield* authorize([id]);
        return present(
          yield* forEachOutcome([id], (runId) =>
            operation.action === "grant"
              ? service.grantWriteClaims(runId, operation.paths ?? [])
              : operation.action === "revoke"
                ? service.revokeWriteClaims(runId, operation.paths ?? [])
                : service.resumeWriterAdmission(runId),
          ),
        );
      }
    }
  });

  const present = (executionResult: {
    readonly runs: ReadonlyArray<SubagentRunView>;
    readonly awaitContextRuns?: ReadonlyArray<SubagentRunView>;
    readonly startFailures?: ReadonlyArray<SubagentStartFailure>;
    readonly startEntries?: ReadonlyArray<SubagentStartEntry>;
    readonly actionFailures?: ReadonlyArray<SubagentActionFailure>;
    readonly attentionRequired?: boolean;
    readonly text?: string;
  }): AgentToolResult<unknown> => {
    const { runs, awaitContextRuns, attentionRequired, text: formattedText } = executionResult;
    const startFailures = executionResult.startFailures ?? [];
    const actionFailures = executionResult.actionFailures ?? [];
    const details: unknown =
      input.tool === SUBAGENT_TOOL_NAME.start
        ? makeStartDetails({
            // Every start result contains the complete request-ordered receipt.
            startEntries: executionResult.startEntries ?? [],
            ...(startFailures.length > 0 && { startFailures }),
          })
        : input.tool === SUBAGENT_TOOL_NAME.await
          ? makeAwaitDetails({
              runs,
              contextRuns: awaitContextRuns,
              awaitedRunIds: requestedAwaitIds,
              awaitUntil: input.args.until,
              ...(attentionRequired === true && { attentionRequired: true as const }),
            })
          : makeCompactToolDetails({
              action: subagentToolAction(input),
              runs,
              ...(actionFailures.length > 0 && { actionFailures }),
            });
    const detailedText = () => formattedText ?? formatDetailedRuns(runs).text;
    const resultText = (): string => {
      if (input.tool === SUBAGENT_TOOL_NAME.start)
        return formattedText ?? formatStartResult(runs, startFailures);
      const acknowledgement = () =>
        managementAcknowledgement(
          subagentToolAction(input),
          runs,
          input.tool === SUBAGENT_TOOL_NAME.claims ? input.args.action : undefined,
        );
      // Status keeps its detailed text even when some targets failed.
      if (actionFailures.length > 0)
        return input.tool === SUBAGENT_TOOL_NAME.status
          ? detailedText()
          : joinBoundedToolText([acknowledgement(), formatActionFailures(actionFailures)]);
      if (runs.length === 0) return "No subagent runs.";
      switch (input.tool) {
        case SUBAGENT_TOOL_NAME.list:
          return projectRunCardTree(runs)
            .map((row) => `${runTreeBranch(row)}${formatRun(row.run)}`)
            .join("\n");
        case SUBAGENT_TOOL_NAME.status:
        case SUBAGENT_TOOL_NAME.await:
          return detailedText();
        default:
          return acknowledgement();
      }
    };
    return { content: [{ type: "text", text: boundToolOutput(resultText()) }], details };
  };
  return effect;
};

export const executeSubagentAction = (
  pi: ExtensionAPI,
  runtime: SubagentToolRuntime,
  input: SubagentToolInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> => {
  const awaitState =
    input.tool === SUBAGENT_TOOL_NAME.await
      ? makeAwaitExecution(input.args.runIds, input.args.until, onUpdate)
      : undefined;
  const executing = runtime.proxyCall
    ? runtime.proxyCall(input, signal, awaitState?.markInterrupted)
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
          ),
          awaitState?.markInterrupted,
        ),
        signal,
      );
  return executing.catch((error) => {
    if (!awaitState?.wasInterrupted()) throw error;
    // The runtime Promise settles only after the interrupted operation releases its claims.
    const result = awaitState.cancelled(runtime.proxyCall !== undefined);
    // Progress cannot replace the persisted result.
    invokeHostCallback(() => onUpdate?.(result), undefined);
    return result;
  });
};
