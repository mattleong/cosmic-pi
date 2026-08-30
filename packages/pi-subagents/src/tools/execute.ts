// Pi tool execution is a Promise-shaped host boundary.
import { sanitizeTerminalLine, type JsonObject } from "pi-cosmic-core";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { SubagentToolPresentation } from "../boundary/host-activity-widget.ts";
import {
  hostProfileEnvironment,
  resolveProfileRetry,
  resolveProfileStart,
  type SubagentSessionEnvironment,
} from "../boundary/host-profile-resolution.ts";
import type { SubagentBackendRegistry } from "../backend/service.ts";
import {
  normalizeProfileId,
  profileCandidateLabel,
  PROFILE_IDS,
  type ProfileId,
} from "../profiles/model.ts";
import {
  SubagentProfileService,
  type SubagentProfileServiceContract,
} from "../profiles/service.ts";
import type { SessionProfileSnapshot } from "../profiles/session-overrides.ts";
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
import { MAX_START_BATCH, MAX_TARGET_RUNS } from "../run/limits.ts";
import { getFailedStartRecovery } from "../run/launch.ts";
import { SubagentService, type SubagentRunObservation } from "../run/service.ts";
import { runStateLabel } from "../ui/run-state.ts";
import {
  makeAwaitDetails,
  makeCompactToolDetails,
  makeStartDetails,
  type SubagentStartEntry,
} from "./details.ts";
import {
  attentionRecoveryText,
  boundToolOutput,
  formatActionFailures,
  formatDetailedRuns,
  formatRun,
  formatStartResult,
  joinBoundedToolText,
  renderedCompletionReceipts,
} from "./format.ts";
import {
  disallowedLaunchOverrideMessage,
  firstDisallowedLaunchOverride,
} from "../run/launch-validation.ts";
import { formatAwaitProgress } from "./render-await.ts";
import { projectRunCardTree, runCardTreeBranch } from "./run-card-tree.ts";
import type {
  ProfileCandidateDiscovery,
  SubagentActionFailure,
  SubagentProfileView,
  SubagentStartFailure,
  SubagentStartOutcome,
  SubagentStartResolvedRoute,
} from "./model.ts";
import type { SubagentModelsInput, SubagentStartSpec, SubagentToolInput } from "./schema.ts";

export interface SubagentToolRuntime {
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

const matchActionOutcome = (id: string) =>
  Effect.match({
    onFailure: (error: SubagentError) => ({
      failure: {
        id,
        message: error.message,
        code: subagentErrorCode(error),
      } satisfies SubagentActionFailure,
    }),
    onSuccess: (run: SubagentRunView) => ({ run }),
  });

type ActionOutcome =
  | { readonly run: SubagentRunView }
  | { readonly failure: SubagentActionFailure };

const splitOutcomes = (outcomes: ReadonlyArray<ActionOutcome>) => ({
  runs: outcomes.flatMap((outcome) => ("run" in outcome ? [outcome.run] : [])),
  actionFailures: outcomes.flatMap((outcome) => ("failure" in outcome ? [outcome.failure] : [])),
});

const singleOutcome = (outcome: ActionOutcome) =>
  "run" in outcome ? { runs: [outcome.run] } : { runs: [], actionFailures: [outcome.failure] };

const requiredRunId = (
  action: SubagentToolInput["action"],
  runId: string,
): Effect.Effect<string, InvalidSubagentRequestError> =>
  runId.trim()
    ? Effect.succeed(runId.trim())
    : Effect.fail(
        new InvalidSubagentRequestError({
          code: "run_id_required",
          message: `${action} requires runId.`,
        }),
      );

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

const startSpecs = (
  agents: ReadonlyArray<SubagentStartSpec>,
): Effect.Effect<ReadonlyArray<SubagentStartSpec>, InvalidSubagentRequestError> =>
  Effect.gen(function* () {
    if (agents.length === 0 || agents.length > MAX_START_BATCH)
      return yield* new InvalidSubagentRequestError({
        code: "agent_count_invalid",
        message: `subagent_start requires between 1 and ${MAX_START_BATCH} agents.`,
      });
    for (const agent of agents) {
      // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
      const disallowedField = firstDisallowedLaunchOverride(agent as Readonly<JsonObject>);
      if (disallowedField)
        return yield* new InvalidSubagentRequestError({
          code: "launch_override_not_allowed",
          message: disallowedLaunchOverrideMessage(disallowedField),
        });
    }
    return agents.map((agent) => {
      const profile = agent.profile ? normalizeProfileId(agent.profile) : undefined;
      return profile ? { ...agent, profile } : agent;
    });
  });

const requiredMessage = (
  action: SubagentToolInput["action"],
  message: string,
): Effect.Effect<string, InvalidSubagentRequestError> =>
  message.trim()
    ? Effect.succeed(message.trim())
    : Effect.fail(
        new InvalidSubagentRequestError({
          code: "message_required",
          message: `${action} requires message.`,
        }),
      );

const profileDiscovery = (
  input: SubagentModelsInput,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  profiles: SubagentProfileServiceContract,
  snapshot: SessionProfileSnapshot,
): ReadonlyArray<SubagentProfileView> => {
  const requestedProfile = input.profile ? normalizeProfileId(input.profile) : undefined;
  const ids = input.profile ? (requestedProfile ? [requestedProfile] : []) : PROFILE_IDS;
  const environment = hostProfileEnvironment(pi, ctx);
  return ids.flatMap((id) => {
    const definition = profiles.definition(id);
    if (!definition) return [];
    const route = snapshot.effectiveConfig.profiles[definition.id];
    const resolution = profiles.resolve(snapshot, definition.id, environment);
    const attempts = resolution.kind === "resolved" ? resolution.attempts : [];
    const skipped = resolution.skippedCandidates;
    const candidates: ProfileCandidateDiscovery[] = route.candidates.map((candidate, index) => {
      const attempt = attempts.find((value) => value.candidateIndex === index);
      const omitted = skipped.find((value) => value.candidateIndex === index);
      return {
        ...candidate,
        status: attempt ? "eligible" : "skipped",
        reason: attempt
          ? "Candidate adapter is statically eligible before native authentication/integration/harness readiness."
          : (omitted?.reason ?? "Candidate was not eligible."),
      };
    });
    return [
      {
        id: definition.id,
        description: definition.description,
        source: snapshot.effectiveConfig.profileSources[definition.id],
        isDefault: definition.id === "generalist",
        defaultContext: definition.defaultContext,
        defaultWriteIntent: definition.defaultWriteIntent,
        ...(definition.defaultEffort !== undefined && {
          defaultEffort: definition.defaultEffort,
        }),
        candidates,
      } satisfies SubagentProfileView,
    ];
  });
};

const formatProfileDiscovery = (
  profiles: ReadonlyArray<SubagentProfileView>,
  fallbackProfile: ProfileId,
): string =>
  [
    "Profile routes · static preflight",
    `Profile omitted → ${fallbackProfile}`,
    "Each candidate lists host/runtime/model, effort, context, write intent, fast mode, and retention.",
    "Static eligibility only · executable, authentication, integration, and private-harness checks run at launch.",
    "",
    ...profiles.flatMap((profile) => [
      `${profile.id}${profile.isDefault ? " · when omitted" : ""} — ${profile.description}`,
      `  source=${profile.source} · defaults: context=${profile.defaultContext} · intent=${profile.defaultWriteIntent} · effort=${profile.defaultEffort ?? "inherit"}`,
      ...(profile.candidates.length > 0
        ? profile.candidates.map(
            (candidate, index) =>
              `  ${index + 1}. ${profileCandidateLabel(candidate)} · ${candidate.status}\n     ${candidate.reason}`,
          )
        : ["  disabled · no candidates"]),
      "",
    ]),
  ].join("\n");

const managementAcknowledgement = (
  action: Exclude<SubagentToolInput["action"], "models" | "start">,
  runs: ReadonlyArray<SubagentRunView>,
  claimsAction?: "list" | "grant" | "revoke" | "resume_admission",
): string => {
  const ids = runs.map((run) => run.id).join(", ");
  if (runs.length === 0) return "";
  switch (action) {
    case "send": {
      // Retained (closeOnReport=false) targets consumed the send as their next
      // assignment rather than as guidance inside an active one.
      const guided = runs.filter((run) => run.closeOnReport !== false);
      const retained = runs.filter((run) => run.closeOnReport === false);
      const idList = (targets: ReadonlyArray<SubagentRunView>): string =>
        targets.map((run) => run.id).join(", ");
      return [
        ...(guided.length > 0
          ? [
              `Guidance delivered to ${guided.length} subagent${guided.length === 1 ? "" : "s"}: ${idList(guided)}.`,
            ]
          : []),
        ...(retained.length > 0
          ? [
              `Started the next assignment on ${retained.length} retained subagent${retained.length === 1 ? "" : "s"}: ${idList(retained)}; subagent_await now targets the new report generation.`,
            ]
          : []),
      ].join("\n");
    }
    case "reply":
      return `Reply delivered to ${ids}.`;
    case "retry":
      return runs
        .map((run) =>
          run.predecessorRunId
            ? `Continued ${run.predecessorRunId} as ${run.id} on profile ${run.profile ?? "generalist"} candidate ${(run.selection.candidateIndex ?? 0) + 1}.`
            : `Started next profile candidate as ${run.id}.`,
        )
        .join("\n");
    case "interrupt":
      return `Interrupted ${ids}; state is paused.`;
    case "resume":
      return `Resumed ${ids}.`;
    case "rename":
      return runs.map((run) => `${run.id} renamed to ${run.name}.`).join("\n");
    case "stop":
      return runs
        .map((run) => {
          switch (run.state) {
            case "stopped":
              return `${run.id} is stopped.`;
            case "completed":
              return `${run.id} was already finished; no stop was needed.`;
            case "failed":
              return `${run.id} had already failed; no stop was needed.`;
            case "stopping":
              return `Stop cleanup is still in progress for ${run.id}.`;
            default:
              return `Stop requested for ${run.id}; current state is ${runStateLabel(run.state)}.`;
          }
        })
        .join("\n");
    case "claims": {
      const contained =
        claimsAction === "resume_admission" ||
        runs.some((run) => run.writeAdmissionPaused === true);
      return [
        ...runs.map(
          (run) =>
            `${run.id}: ${run.writeClaims?.length ? run.writeClaims.join(", ") : run.writeIntent === "writer" ? "exclusive writer" : "read-only"}${run.writeAdmissionPaused ? " · admission paused" : ""}`,
        ),
        contained
          ? "Claim-containment recovery uses resume_admission, then lifecycle resume with the authoritative claims, or stop and replace when resume is unavailable. Do not use subagent_reply for containment."
          : "For a waiting worker, send the resulting authoritative claim set in subagent_reply before work continues.",
      ].join("\n");
    }
    default:
      return runs.map((run) => formatRun(run, true)).join("\n\n");
  }
};

const boundedAwaitContext = (
  targets: ReadonlyArray<SubagentRunView>,
  contextRuns: ReadonlyArray<SubagentRunView>,
): ReadonlyArray<SubagentRunView> =>
  projectRunCardTree(contextRuns)
    .map((row) => row.run)
    .slice(0, Math.max(0, MAX_TARGET_RUNS - targets.length));

const awaitDescendantContext = (
  targets: ReadonlyArray<SubagentRunView>,
  projection: ReadonlyArray<SubagentRunView>,
): ReadonlyArray<SubagentRunView> => {
  const targetIds = new Set(targets.map((run) => run.id));
  const byId = new Map(projection.map((run) => [run.id, run]));
  return projection.filter((run) => {
    if (targetIds.has(run.id)) return false;
    const visited = new Set<string>([run.id]);
    let parentRunId = run.parentRunId;
    while (parentRunId && visited.add(parentRunId)) {
      if (targetIds.has(parentRunId)) return true;
      parentRunId = byId.get(parentRunId)?.parentRunId;
    }
    return false;
  });
};

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
  if (input.action === "models") {
    const discovery = Effect.gen(function* () {
      const profileService = yield* SubagentProfileService;
      const snapshot = yield* profileService.capture;
      const profiles = profileDiscovery(input, pi, ctx, profileService, snapshot);
      return {
        content: [
          {
            type: "text" as const,
            text: boundToolOutput(
              formatProfileDiscovery(profiles, snapshot.effectiveConfig.fallbackProfile),
            ),
          },
        ],
        details: makeCompactToolDetails({
          action: input.action,
          profiles,
          fallbackProfile: snapshot.effectiveConfig.fallbackProfile,
        }),
      };
    });
    return discovery;
  }

  let latestAwaitRuns: ReadonlyArray<SubagentRunView> = [];
  let latestAwaitContextRuns: ReadonlyArray<SubagentRunView> = [];
  const requestedAwaitUntil = input.action === "await" ? input.until : undefined;
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
    const finishObservations = (observations: ReadonlyArray<SubagentRunObservation>) =>
      Effect.gen(function* () {
        const runs = observations.map((observation) => observation.run);
        const attentionRequired = runs.some(isParentActionRequiredRun);
        const attentionText = attentionRecoveryText(runs);
        const hierarchy = formatAwaitProgress(
          runs,
          requestedAwaitUntil ?? "all_finished",
          boundedAwaitContext(runs, latestAwaitContextRuns),
        );
        const prefix = [hierarchy, attentionText].filter(Boolean).join("\n\n");
        const formatted = formatDetailedRuns(runs, prefix ? `${prefix}\n\n` : "");
        yield* consumeCompletions(observations, formatted.fullyRenderedIds);
        return {
          runs,
          awaitContextRuns: latestAwaitContextRuns,
          attentionRequired,
          text: formatted.text,
        };
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
            return Effect.gen(function* () {
              const runs = observations.map((observation) => observation.run);
              const failureText = formatActionFailures(actionFailures);
              const attentionRequired = runs.some(isParentActionRequiredRun);
              const attentionText = attentionRecoveryText(runs);
              const prefix = [failureText, attentionText].filter(Boolean).join("\n\n");
              const formatted = formatDetailedRuns(runs, prefix ? `${prefix}\n\n` : "");
              yield* consumeCompletions(observations, formatted.fullyRenderedIds);
              return {
                runs,
                attentionRequired,
                text: formatted.text,
                actionFailures,
              };
            });
          }),
        ),
      );

    switch (input.action) {
      case "start": {
        const specs = yield* startSpecs(input.agents);
        const partialOutcomes = new Map<number, SubagentStartOutcome>();
        const requestedProfileFor = (spec: SubagentStartSpec): string =>
          sanitizeTerminalLine(spec.profile?.trim() || "generalist");
        const routeForRequest = (request: StartSubagentRequest): SubagentStartResolvedRoute => {
          const candidateIndex = request.selection?.candidateIndex;
          const warning = request.selection?.warning;
          return {
            profile: request.profile ?? "generalist",
            host: request.host,
            runtime: request.runtime,
            model: request.model,
            effort: request.effort,
            openaiFastMode: request.openaiFastMode,
            ...(candidateIndex !== undefined && { candidateIndex }),
            ...(warning !== undefined && warning.length > 0 && { warning }),
          };
        };
        const startEntriesFor = (
          outcomes: ReadonlyMap<number, SubagentStartOutcome>,
        ): ReadonlyArray<SubagentStartEntry> =>
          specs.map((spec, index): SubagentStartEntry => {
            const outcome = outcomes.get(index);
            const base = {
              index,
              name: sanitizeTerminalLine(spec.name?.trim() || `launch ${index + 1}`),
              profile: requestedProfileFor(spec),
            } as const;
            if (!outcome) return { ...base, status: "pending", routeStatus: "resolving" };
            if ("run" in outcome)
              return {
                ...base,
                profile: outcome.run.profile ?? base.profile,
                status: "started" as const,
                routeStatus: "selected" as const,
                host: outcome.run.host,
                runtime: outcome.run.runtime,
                model: outcome.run.model,
                effort: outcome.run.effort,
                openaiFastMode: outcome.run.openaiFastMode,
                ...(outcome.run.selection.candidateIndex !== undefined && {
                  candidateIndex: outcome.run.selection.candidateIndex,
                }),
                ...(outcome.run.selection.warning !== undefined &&
                  outcome.run.selection.warning.length > 0 && {
                    warning: outcome.run.selection.warning,
                  }),
                runId: outcome.run.id,
              };
            if (outcome.resolvedRoute) {
              const { candidateIndex, warning, ...route } = outcome.resolvedRoute;
              return {
                ...base,
                status: "failed" as const,
                routeStatus: "selected" as const,
                ...route,
                ...(warning !== undefined && warning.length > 0 && { warning }),
                ...(candidateIndex !== undefined && { candidateIndex }),
              };
            }
            return {
              ...base,
              status: "failed" as const,
              routeStatus: "unavailable" as const,
            };
          });
        const failureFor = (
          spec: SubagentStartSpec,
          index: number,
          error: SubagentError,
          resolvedRoute?: SubagentStartResolvedRoute,
        ): SubagentStartOutcome => {
          const name = spec.name?.trim();
          const admittedRun = getFailedStartRecovery(error);
          return {
            index,
            failure: {
              index,
              ...(name !== undefined && name.length > 0 && { name }),
              message: error.message,
              code: subagentErrorCode(error),
              ...(admittedRun !== undefined && { admittedRun }),
            },
            ...(resolvedRoute !== undefined && { resolvedRoute }),
          };
        };
        const publishOutcome = (outcome: SubagentStartOutcome): Effect.Effect<void> => {
          partialOutcomes.set(outcome.index, outcome);
          const ordered = [...partialOutcomes.values()].sort(
            (left, right) => left.index - right.index,
          );
          const launched = ordered.flatMap((entry) => ("run" in entry ? [entry.run] : []));
          const failures = ordered.flatMap((entry) => ("failure" in entry ? [entry.failure] : []));
          const pendingEntries = specs.flatMap((spec, index) =>
            partialOutcomes.has(index)
              ? []
              : [
                  `#${index + 1} ${sanitizeTerminalLine(spec.name?.trim() || `launch ${index + 1}`)}`,
                ],
          );
          const pending = pendingEntries.length;
          const summary = `Processed ${ordered.length} of ${specs.length} launches · ${launched.length} started · ${failures.length} failed${pending > 0 ? ` · ${pending} pending (${pendingEntries.join(", ")})` : ""}.`;
          return Effect.sync(() =>
            onUpdate?.({
              content: [{ type: "text", text: summary }],
              details: makeStartDetails({
                startEntries: startEntriesFor(partialOutcomes),
                ...(failures.length > 0 && { startFailures: failures }),
              }),
            }),
          ).pipe(
            Effect.catchDefect(() => Effect.void),
            Effect.asVoid,
          );
        };
        const profileService = yield* SubagentProfileService;
        const profileSnapshot = yield* profileService.capture;
        const resolveRequest = (spec: SubagentStartSpec) =>
          resolveProfileStart(pi, spec, ctx, environment, profileSnapshot).pipe(
            Effect.map((request) => ({
              ...request,
              nestingPolicy: profileSnapshot.effectiveConfig.nesting,
              nestingPolicyRevision: profileSnapshot.revision,
            })),
          );
        const launchOne = (spec: SubagentStartSpec, index: number) =>
          resolveRequest(spec).pipe(
            Effect.flatMap((request) =>
              startOwned(request).pipe(
                Effect.map(
                  (run): SubagentStartOutcome => ({
                    index,
                    run,
                  }),
                ),
                Effect.catch((error) =>
                  Effect.succeed(failureFor(spec, index, error, routeForRequest(request))),
                ),
              ),
            ),
            Effect.catch((error) => Effect.succeed(failureFor(spec, index, error))),
            Effect.tap(publishOutcome),
          );
        const summarize = (outcomes: ReadonlyArray<SubagentStartOutcome>) => {
          const ordered = [...outcomes].sort((left, right) => left.index - right.index);
          const launched = ordered.flatMap((outcome) => ("run" in outcome ? [outcome.run] : []));
          const failures = ordered.flatMap((outcome) =>
            "failure" in outcome ? [outcome.failure] : [],
          );
          const finalOutcomes = new Map(ordered.map((outcome) => [outcome.index, outcome]));
          const startEntries = startEntriesFor(finalOutcomes);
          return Effect.succeed({ runs: launched, startFailures: failures, startEntries });
        };

        const outcomes = yield* Effect.forEach(specs, launchOne, {
          concurrency: MAX_START_BATCH,
        });
        return yield* summarize(outcomes);
      }
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
          latestAwaitContextRuns = awaitDescendantContext(runs, projection ?? runs);
          const displayedContext = boundedAwaitContext(runs, latestAwaitContextRuns);
          const text = formatAwaitProgress(runs, until, displayedContext);
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
          finishObservations,
        );
      }
      case "send": {
        const ids = yield* requiredTargetIds(input.action, input.runIds);
        const message = yield* requiredMessage(input.action, input.message);
        yield* authorize(ids);
        const outcomes = yield* Effect.forEach(
          ids,
          (id) => service.send(id, message).pipe(matchActionOutcome(id)),
          { concurrency: 8 },
        );
        return splitOutcomes(outcomes);
      }
      case "reply": {
        const id = yield* requiredRunId(input.action, input.runId);
        const message = yield* requiredMessage(input.action, input.message);
        yield* authorize([id]);
        const outcome = yield* service.reply(id, message).pipe(matchActionOutcome(id));
        return singleOutcome(outcome);
      }
      case "retry": {
        const ids = yield* requiredTargetIds(input.action, input.runIds);
        const profileService = yield* SubagentProfileService;
        const policySnapshot = yield* profileService.capture;
        yield* authorize(ids);
        const outcomes = yield* Effect.forEach(
          ids,
          (id) => {
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
              (claim) =>
                handedOff ? Effect.void : service.releaseRetryClaim(id, claim.claimToken),
            );
            return operation.pipe(matchActionOutcome(id));
          },
          { concurrency: 8 },
        );
        return splitOutcomes(outcomes);
      }
      case "interrupt":
      case "resume":
      case "stop": {
        if (input.action !== "resume" && "message" in input && input.message !== undefined)
          return yield* new InvalidSubagentRequestError({
            code: "lifecycle_message_invalid",
            message: 'subagent_lifecycle message is valid only when action="resume".',
          });
        const ids = yield* requiredTargetIds(input.action, input.runIds);
        yield* authorize(ids);
        const outcomes = yield* Effect.forEach(
          ids,
          (id) => {
            const operation = (() => {
              switch (input.action) {
                case "interrupt":
                  return service.interrupt(id);
                case "resume":
                  return service.resume(id, input.message);
                case "stop":
                  return service.stop(id);
              }
            })();
            return operation.pipe(matchActionOutcome(id));
          },
          { concurrency: 8 },
        );
        return splitOutcomes(outcomes);
      }
      case "rename": {
        const id = yield* requiredRunId(input.action, input.runId);
        yield* authorize([id]);
        const outcome = yield* service.rename(id, input.name.trim()).pipe(matchActionOutcome(id));
        return singleOutcome(outcome);
      }
      case "claims": {
        const operation = input.operation;
        if (operation.action === "list")
          return yield* finishStatus(yield* requiredTargetIds(input.action, operation.runIds));
        const id = yield* requiredRunId(input.action, operation.runId);
        yield* authorize([id]);
        const effect =
          operation.action === "grant"
            ? service.grantWriteClaims(id, operation.paths)
            : operation.action === "revoke"
              ? service.revokeWriteClaims(id, operation.paths)
              : service.resumeWriterAdmission(id);
        const outcome = yield* effect.pipe(matchActionOutcome(id));
        return singleOutcome(outcome);
      }
    }
  });

  const renderAwaitCancellation = Effect.try(() => {
    if (input.action !== "await" || !requestedAwaitUntil) return;
    const unfinished = latestAwaitRuns.filter(
      (run) => !isAssignmentFinishedRunState(run.state),
    ).length;
    const attention = attentionRecoveryText(latestAwaitRuns);
    const hierarchy =
      latestAwaitRuns.length > 0
        ? formatAwaitProgress(
            latestAwaitRuns,
            requestedAwaitUntil,
            boundedAwaitContext(latestAwaitRuns, latestAwaitContextRuns),
          )
        : "";
    const summary =
      latestAwaitRuns.length === 0
        ? "Await canceled before progress was observed; selected subagents may still be unfinished."
        : `Await canceled; ${unfinished} subagent${unfinished === 1 ? " is" : "s are"} unfinished.`;
    const text = [summary, hierarchy, attention].filter(Boolean).join("\n\n");
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
        const startEntries = executionResult.startEntries;
        const actionFailures = executionResult.actionFailures ?? [];
        const startDetailsInput = {
          // Every start result contains the complete request-ordered receipt.
          startEntries: startEntries ?? [],
          ...(startFailures.length > 0 && { startFailures }),
        };
        const awaitDetailsInput = {
          runs,
          contextRuns: awaitContextRuns,
          awaitedRunIds: requestedAwaitIds,
          awaitUntil: input.action === "await" ? input.until : ("all_finished" as const),
          ...(attentionRequired === true && { attentionRequired: true as const }),
        };
        const compactDetailsInput = {
          action:
            input.action === "start" || input.action === "await" ? ("list" as const) : input.action,
          runs,
          ...(actionFailures.length > 0 && { actionFailures }),
        };
        const details: unknown =
          input.action === "start"
            ? makeStartDetails(startDetailsInput)
            : input.action === "await"
              ? makeAwaitDetails(awaitDetailsInput)
              : makeCompactToolDetails(compactDetailsInput);
        const text =
          input.action === "start"
            ? (formattedText ?? formatStartResult(runs, startFailures))
            : actionFailures.length > 0
              ? input.action === "status"
                ? (formattedText ?? formatDetailedRuns(runs).text)
                : joinBoundedToolText([
                    managementAcknowledgement(
                      input.action,
                      runs,
                      input.action === "claims" ? input.operation.action : undefined,
                    ),
                    formatActionFailures(actionFailures),
                  ])
              : runs.length === 0
                ? "No subagent runs."
                : input.action === "list"
                  ? projectRunCardTree(runs)
                      .map((row) => `${runCardTreeBranch(row)}${formatRun(row.run)}`)
                      .join("\n")
                  : input.action === "status"
                    ? (formattedText ?? formatDetailedRuns(runs).text)
                    : input.action === "await"
                      ? (formattedText ?? formatDetailedRuns(runs).text)
                      : managementAcknowledgement(
                          input.action,
                          runs,
                          input.action === "claims" ? input.operation.action : undefined,
                        );
        return { content: [{ type: "text", text: boundToolOutput(text) }], details };
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
