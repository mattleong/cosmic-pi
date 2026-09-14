// Pi tool execution is a Promise-shaped host boundary.
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { CompactAnimationScheduler } from "pi-code-previews";
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
  isAssignmentFinishedRunState,
  isParentActionRequiredRun,
  type StartSubagentRequest,
  type SubagentRunView,
} from "../run/model.ts";
import { MAX_TARGET_RUNS } from "../run/limits.ts";
import { SubagentService, type SubagentRunObservation } from "../run/service.ts";
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
import { formatAwaitProgress } from "./render-await.ts";
import { projectRunCardTree, runTreeBranch } from "../ui/run-tree-rows.ts";
import { executeModelsAction } from "./execute-models.ts";
import { executeWorkspaceAction } from "./execute-workspace.ts";
import type { SubagentActionFailure, SubagentStartFailure } from "./model.ts";
import type { SubagentToolInput } from "./schema.ts";
import { claimsOperationError } from "./schema.ts";

export interface SubagentToolRuntime {
  readonly scheduleAnimation?: CompactAnimationScheduler | undefined;
  readonly environment: SubagentSessionEnvironment;
  /** Private nested-Pi transport. Public/root registrations leave this absent. */
  readonly proxyCall?:
    | ((
        input: SubagentToolInput,
        signal: AbortSignal | undefined,
        onUpdate: AgentToolUpdateCallback<unknown> | undefined,
        ctx: ExtensionContext,
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
  action: SubagentToolInput["action"],
): Effect.Effect<string, InvalidSubagentRequestError> =>
  value.trim()
    ? Effect.succeed(value.trim())
    : Effect.fail(
        new InvalidSubagentRequestError({ code, message: `${action} requires ${label}.` }),
      );

const requiredRunId = (action: SubagentToolInput["action"], runId: string) =>
  requiredField(runId, "run_id_required", "runId", action);

const requiredMessage = (action: SubagentToolInput["action"], message: string) =>
  requiredField(message, "message_required", "message", action);

const requiredTargetIds = (
  action: SubagentToolInput["action"],
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
  _signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ctx: ExtensionContext,
  callerRunId?: string,
): Effect.Effect<
  AgentToolResult<unknown>,
  SubagentError,
  SubagentService | SubagentProfileService | SubagentBackendRegistry
> => {
  if (input.action === "models") return executeModelsAction(input, pi, ctx);
  if (input.action === "workspace") return executeWorkspaceAction(input.operation, callerRunId);

  let latestAwaitRuns: ReadonlyArray<SubagentRunView> = [];
  let latestAwaitContextRuns: ReadonlyArray<SubagentRunView> = [];
  const requestedAwaitUntil = input.action === "await" ? input.until : undefined;
  /** Shared await progress projection for live updates, settlement, and cancellation:
   * bounded descendant context, then the hierarchical summary. */
  const awaitProgressText = (runs: ReadonlyArray<SubagentRunView>): string =>
    formatAwaitProgress(
      runs,
      requestedAwaitUntil ?? "all_finished",
      projectRunCardTree(latestAwaitContextRuns)
        .map((row) => row.run)
        .slice(0, Math.max(0, MAX_TARGET_RUNS - runs.length)),
    );
  const requestedAwaitIds =
    input.action === "await"
      ? [...new Set(input.runIds.map((id) => id.trim()).filter(Boolean))]
      : undefined;
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
    // Shared observed-run completion: ordered sections, then attention recovery, then
    // detailed runs; consumes completion receipts for fully rendered runs.
    const completeObservations = (
      observations: ReadonlyArray<SubagentRunObservation>,
      sections: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        const runs = observations.map((observation) => observation.run);
        const attentionRequired = runs.some(isParentActionRequiredRun);
        const prefix = joinSections([...sections, attentionRecoveryText(runs)]);
        const formatted = formatDetailedRuns(runs, prefix ? `${prefix}\n\n` : "");
        yield* consumeCompletions(observations, formatted.fullyRenderedIds);
        return { runs, attentionRequired, text: formatted.text };
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
            return Effect.map(
              completeObservations(observations, [formatActionFailures(actionFailures)]),
              (outcome) => ({ ...outcome, actionFailures }),
            );
          }),
        ),
      );

    switch (input.action) {
      case "start":
        return yield* executeStartBatch({
          agents: input.agents,
          pi,
          ctx,
          environment,
          startOwned,
          onUpdate,
        });
      case "list":
        return { runs: yield* callerRunId ? service.visibleList(callerRunId) : service.list };
      case "status":
        return yield* finishStatus(yield* requiredTargetIds(input.action, input.runIds));
      case "await": {
        const ids = yield* requiredTargetIds(input.action, input.runIds);
        const until = input.until;
        yield* authorize(ids);
        let lastUpdate = "";
        const updateAwait = (
          runs: ReadonlyArray<SubagentRunView>,
          projection?: ReadonlyArray<SubagentRunView>,
        ) => {
          latestAwaitRuns = runs;
          // Await context is the projected tree minus the awaited targets and their
          // ancestors: only strict descendants of the awaited runs belong on the card.
          const scope = projection ?? runs;
          const targetIds = new Set(runs.map((run) => run.id));
          const byId = new Map(scope.map((run) => [run.id, run]));
          latestAwaitContextRuns = scope.filter((run) => {
            if (targetIds.has(run.id)) return false;
            const visited = new Set<string>([run.id]);
            let parentRunId = run.parentRunId;
            while (parentRunId && visited.add(parentRunId)) {
              if (targetIds.has(parentRunId)) return true;
              parentRunId = byId.get(parentRunId)?.parentRunId;
            }
            return false;
          });
          const text = awaitProgressText(runs);
          const details = makeAwaitDetails({
            runs,
            contextRuns: latestAwaitContextRuns,
            awaitedRunIds: ids,
            awaitUntil: until,
          });
          const updateKey = JSON.stringify(details);
          if (updateKey === lastUpdate) return;
          lastUpdate = updateKey;
          onUpdate?.({
            content: [{ type: "text", text }],
            details,
          });
        };
        return yield* service.withAwaitTerminalObservations(
          ids,
          until,
          updateAwait,
          (observations) =>
            Effect.gen(function* () {
              const runs = observations.map((observation) => observation.run);
              const outcome = yield* completeObservations(observations, [awaitProgressText(runs)]);
              return { ...outcome, awaitContextRuns: latestAwaitContextRuns };
            }),
        );
      }
      case "send": {
        const ids = yield* requiredTargetIds(input.action, input.runIds);
        const message = yield* requiredMessage(input.action, input.message);
        yield* authorize(ids);
        return yield* forEachOutcome(ids, (id) => service.send(id, message));
      }
      case "reply": {
        const id = yield* requiredRunId(input.action, input.runId);
        const message = yield* requiredMessage(input.action, input.message);
        yield* authorize([id]);
        return yield* forEachOutcome([id], (runId) => service.reply(runId, message));
      }
      case "retry": {
        const ids = yield* requiredTargetIds(input.action, input.runIds);
        const profileService = yield* SubagentProfileService;
        const policySnapshot = yield* profileService.capture;
        yield* authorize(ids);
        return yield* forEachOutcome(ids, (id) => {
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
                  Effect.uninterruptibleMask((restore) =>
                    Effect.sync(() => {
                      handedOff = true;
                    }).pipe(Effect.andThen(restore(service.startRetrySessionOwned(request)))),
                  ),
                ),
              ),
            (claim) => (handedOff ? Effect.void : service.releaseRetryClaim(id, claim.claimToken)),
          );
          return operation;
        });
      }
      case "interrupt":
      case "resume":
      case "stop": {
        if (input.action !== "resume" && input.message !== undefined)
          return yield* new InvalidSubagentRequestError({
            code: "lifecycle_message_invalid",
            message: 'subagent_lifecycle message is valid only when action="resume".',
          });
        const ids = yield* requiredTargetIds(input.action, input.runIds);
        yield* authorize(ids);
        // Property narrowing does not survive the forEach closure boundary, so hoist the
        // case-group-narrowed action before the callback.
        const lifecycleAction = input.action;
        return yield* forEachOutcome(ids, (id) =>
          lifecycleAction === "interrupt"
            ? service.interrupt(id)
            : lifecycleAction === "resume"
              ? service.resume(id, input.message)
              : service.stop(id),
        );
      }
      case "rename": {
        const id = yield* requiredRunId(input.action, input.runId);
        yield* authorize([id]);
        return yield* forEachOutcome([id], (runId) => service.rename(runId, input.name.trim()));
      }
      case "claims": {
        const operation = input.operation;
        const operationError = claimsOperationError(operation);
        if (operationError !== undefined)
          return yield* new InvalidSubagentRequestError({
            code: "claims_input_invalid",
            message: operationError,
          });
        if (operation.action === "list")
          return yield* finishStatus(
            yield* requiredTargetIds(input.action, operation.runIds ?? []),
          );
        const id = yield* requiredRunId(input.action, operation.runId ?? "");
        yield* authorize([id]);
        return yield* forEachOutcome([id], (runId) =>
          operation.action === "grant"
            ? service.grantWriteClaims(runId, operation.paths ?? [])
            : operation.action === "revoke"
              ? service.revokeWriteClaims(runId, operation.paths ?? [])
              : service.resumeWriterAdmission(runId),
        );
      }
    }
  });

  const renderAwaitCancellation = Effect.try(() => {
    if (input.action !== "await" || !requestedAwaitUntil) return;
    const unfinished = latestAwaitRuns.filter(
      (run) => !isAssignmentFinishedRunState(run.state),
    ).length;
    const summary =
      latestAwaitRuns.length === 0
        ? "Await canceled before progress was observed; selected subagents may still be unfinished."
        : `Await canceled; ${unfinished} subagent${unfinished === 1 ? " is" : "s are"} unfinished.`;
    const text = joinSections([
      summary,
      latestAwaitRuns.length > 0 ? awaitProgressText(latestAwaitRuns) : "",
      attentionRecoveryText(latestAwaitRuns),
    ]);
    onUpdate?.({
      content: [{ type: "text", text }],
      details: makeAwaitDetails({
        runs: latestAwaitRuns,
        contextRuns: latestAwaitContextRuns,
        awaitedRunIds: requestedAwaitIds,
        awaitUntil: requestedAwaitUntil,
        cancelled: true,
      }),
    });
  }).pipe(Effect.ignore);

  return effect.pipe(
    Effect.onInterrupt(() => renderAwaitCancellation),
    Effect.map(
      (executionResult: {
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
          input.action === "start"
            ? makeStartDetails({
                // Every start result contains the complete request-ordered receipt.
                startEntries: executionResult.startEntries ?? [],
                ...(startFailures.length > 0 && { startFailures }),
              })
            : input.action === "await"
              ? makeAwaitDetails({
                  runs,
                  contextRuns: awaitContextRuns,
                  awaitedRunIds: requestedAwaitIds,
                  awaitUntil: input.until,
                  ...(attentionRequired === true && { attentionRequired: true as const }),
                })
              : makeCompactToolDetails({
                  action: input.action,
                  runs,
                  ...(actionFailures.length > 0 && { actionFailures }),
                });
        const detailedText = () => formattedText ?? formatDetailedRuns(runs).text;
        const resultText = (): string => {
          if (input.action === "start")
            return formattedText ?? formatStartResult(runs, startFailures);
          const acknowledgement = () =>
            managementAcknowledgement(
              input.action,
              runs,
              input.action === "claims" ? input.operation.action : undefined,
            );
          // Status keeps its detailed text even when some targets failed.
          if (actionFailures.length > 0)
            return input.action === "status"
              ? detailedText()
              : joinBoundedToolText([acknowledgement(), formatActionFailures(actionFailures)]);
          if (runs.length === 0) return "No subagent runs.";
          switch (input.action) {
            case "list":
              return projectRunCardTree(runs)
                .map((row) => `${runTreeBranch(row)}${formatRun(row.run)}`)
                .join("\n");
            case "status":
            case "await":
              return detailedText();
            default:
              return acknowledgement();
          }
        };
        return { content: [{ type: "text", text: boundToolOutput(resultText()) }], details };
      },
    ),
  );
};

export const executeSubagentAction = (
  pi: ExtensionAPI,
  runtime: SubagentToolRuntime,
  input: SubagentToolInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> =>
  runtime.proxyCall
    ? runtime.proxyCall(input, signal, onUpdate, ctx)
    : runtime.run(
        executeSubagentActionEffect(pi, runtime.environment, input, signal, onUpdate, ctx),
        signal,
      );
