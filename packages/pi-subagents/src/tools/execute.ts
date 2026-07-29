// Pi tool execution is a Promise-shaped host boundary.
// @effect-diagnostics effect/asyncFunction:off
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  hostProfileEnvironment,
  liveSubagentStartBoundaries,
  resolveProfileStart,
  type SubagentSessionEnvironment,
} from "../boundary/host-profile-resolution.ts";
import { PROFILE_IDS, type ProfileId } from "../profiles/model.ts";
import { profileCandidateLabel } from "../profiles/resolve.ts";
import { SubagentProfileService, type SubagentProfileServiceShape } from "../profiles/service.ts";
import {
  InvalidSubagentRequestError,
  subagentErrorCode,
  type SubagentError,
} from "../run/errors.ts";
import {
  CLAUDE_CLI_ALIAS_MODELS,
  launchReadyModelLine,
  MAX_DISCOVERY_RESULTS,
  searchSubagentModels,
  type SubagentModelSearchResult,
} from "../run/model-catalog.ts";
import {
  isTerminalRunState,
  type StartSubagentRequest,
  type SubagentEffort,
  type SubagentModelView,
  type SubagentRunView,
} from "../run/model.ts";
import { MAX_TARGET_RUNS } from "../run/limits.ts";
import { SubagentService, type SubagentRunObservation } from "../run/service.ts";
import { runStateLabel } from "../ui/run-state.ts";
import { makeCompactToolDetails, makeStartAwaitCardDetails } from "./details.ts";
import { attentionRecoveryText, boundToolOutput, joinBoundedToolText } from "./format.ts";
import {
  formatActionFailures,
  formatDetailedRuns,
  formatRun,
  formatStartResult,
  formatStartResultDetails,
  renderedCompletionReceipts,
} from "./output.ts";
import { formatAwaitProgress } from "./render.ts";
import type { SubagentModelsInput, SubagentStartSpec, SubagentToolInput } from "./schema.ts";
import type {
  ProfileCandidateDiscovery,
  SubagentActionFailure,
  SubagentProfileView,
  SubagentStartFailure,
  SubagentStartOutcome,
  SubagentToolBoundaries,
  SubagentToolRuntime,
} from "./subagent.ts";

const LIVE_TOOL_BOUNDARIES: SubagentToolBoundaries = liveSubagentStartBoundaries;

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
    if (agents.length === 0 || agents.length > MAX_TARGET_RUNS)
      return yield* new InvalidSubagentRequestError({
        code: "agent_count_invalid",
        message: `subagent_start requires between 1 and ${MAX_TARGET_RUNS} agents.`,
      });
    const foregroundCount = agents.filter((agent) => agent.execution === "foreground").length;
    if (foregroundCount > 1)
      return yield* new InvalidSubagentRequestError({
        code: "multiple_foreground_agents",
        message:
          "subagent_start accepts at most one foreground agent per call; launch additional agents in background mode to avoid blocking parent questions.",
      });
    return agents;
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

function availableModels(
  input: SubagentModelsInput,
  ctx: ExtensionContext,
  profiles: SubagentProfileServiceShape,
  projectTrusted: boolean,
): SubagentModelSearchResult {
  const piModels: ReadonlyArray<SubagentModelView> = ctx.modelRegistry
    .getAvailable()
    .map((model) => ({
      backend: "pi" as const,
      id: `${model.provider}/${model.id}`,
      name: model.name,
      reasoning: model.reasoning,
      supportedEfforts: getSupportedThinkingLevels(model) as ReadonlyArray<SubagentEffort>,
    }));
  const selectorCatalog = projectTrusted ? [...piModels, ...CLAUDE_CLI_ALIAS_MODELS] : piModels;
  const policyAnnotated = selectorCatalog.flatMap((model) => {
    const policy = profiles.policyFor(model.backend, model.id);
    if (policy === "denied") return [];
    return [{ ...model, ...(policy === "discouraged" ? { policy } : {}) }];
  });
  return searchSubagentModels(policyAnnotated, input.query, input.backend);
}

const profileDiscovery = (
  input: SubagentModelsInput,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  profiles: SubagentProfileServiceShape,
  sessionEnvironment: SubagentSessionEnvironment,
): ReadonlyArray<SubagentProfileView> => {
  const ids = input.profile ? [input.profile] : PROFILE_IDS;
  const environment = hostProfileEnvironment(pi, ctx, sessionEnvironment.projectTrusted);
  return ids.flatMap((id) => {
    const definition = profiles.definition(id);
    if (!definition) return [];
    const route = profiles.config.profiles[definition.id];
    const resolution = profiles.resolve(definition.id, environment);
    const attempts = resolution.kind === "resolved" ? resolution.attempts : [];
    const skipped = resolution.skippedCandidates;
    const candidates: ProfileCandidateDiscovery[] = route.candidates.map((candidate, index) => {
      const attempt = attempts.find((value) => value.candidateIndex === index);
      const omitted = skipped.find((value) => value.candidateIndex === index);
      return {
        order: index + 1,
        candidate: profileCandidateLabel(candidate),
        status: attempt ? "eligible" : "skipped",
        reason: attempt?.reason ?? omitted?.reason ?? "Candidate was not eligible.",
      };
    });
    return [
      {
        id: definition.id,
        description: definition.description,
        defaultContext: definition.defaultContext,
        defaultWriteIntent: definition.defaultWriteIntent,
        ...(definition.defaultEffort ? { defaultEffort: definition.defaultEffort } : {}),
        candidates,
      },
    ];
  });
};

const formatProfileDiscovery = (
  profiles: ReadonlyArray<SubagentProfileView>,
  defaultProfile: ProfileId,
): string =>
  [
    "Static profile preflight (an omitted model evaluates ordered candidates first-to-last; an explicit model selector overrides routing but retains profile guidance and defaults)",
    "Candidate eligibility below is evaluated with each profile's default context; an explicit context override at launch (for example oracle with context=fresh) can change which candidates are eligible.",
    `Configured default profile: ${defaultProfile}`,
    ...profiles.flatMap((profile) => [
      `${profile.id} · context=${profile.defaultContext} · intent=${profile.defaultWriteIntent} · effort=${profile.defaultEffort ?? "inherit"} · ${profile.description}`,
      ...(profile.candidates.length > 0
        ? profile.candidates.map(
            (candidate) =>
              `  ${candidate.order}. ${candidate.candidate} · ${candidate.status} · ${candidate.reason}`,
          )
        : ["  disabled · no candidates"]),
    ]),
  ].join("\n");

const managementAcknowledgement = (
  action: Exclude<SubagentToolInput["action"], "models" | "start">,
  runs: ReadonlyArray<SubagentRunView>,
): string => {
  const ids = runs.map((run) => run.id).join(", ");
  if (runs.length === 0) return "";
  switch (action) {
    case "send":
      return `Guidance delivered to ${runs.length} subagent${runs.length === 1 ? "" : "s"}: ${ids}.`;
    case "reply":
      return `Reply delivered to ${ids}.`;
    case "interrupt":
      return `Paused ${ids}.`;
    case "resume":
      return `Resumed ${ids}.`;
    case "rename":
      return `Renamed ${ids}.`;
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
    default:
      return runs.map((run) => formatRun(run, true)).join("\n\n");
  }
};

export const executeSubagentAction = async (
  pi: ExtensionAPI,
  runtime: SubagentToolRuntime,
  input: SubagentToolInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ctx: ExtensionContext,
  boundaries: SubagentToolBoundaries = runtime.boundaries ?? LIVE_TOOL_BOUNDARIES,
): Promise<AgentToolResult<unknown>> => {
  if (input.action === "models") {
    const discovery = Effect.gen(function* () {
      const profileService = yield* SubagentProfileService;
      const search = availableModels(
        input,
        ctx,
        profileService,
        runtime.environment.projectTrusted,
      );
      const models = search.models;
      const profiles = profileDiscovery(input, pi, ctx, profileService, runtime.environment);
      const selectorText =
        models.length > 0
          ? [
              "Accepted one-field explicit model selectors (preflight-only: denied models are hidden, discouraged models require explicit selection, and executable/auth/model readiness is checked at launch)",
              ...models.map(launchReadyModelLine),
              ...(search.truncated
                ? [
                    `Showing the first ${MAX_DISCOVERY_RESULTS} matching selectors; narrow query or backend to search further.`,
                  ]
                : []),
            ].join("\n")
          : "No matching explicit model selectors.";
      return {
        content: [
          {
            type: "text" as const,
            // Selector-first ordering reserves the most actionable filtered results before verbose
            // profile sections consume the aggregate output budget.
            text: joinBoundedToolText([
              selectorText,
              formatProfileDiscovery(profiles, profileService.config.defaultProfile),
            ]),
          },
        ],
        details: makeCompactToolDetails({
          action: input.action,
          models,
          profileIds: profiles.map((profile) => profile.id),
          defaultProfile: profileService.config.defaultProfile,
        }),
      };
    });
    return runtime.run(discovery, signal);
  }

  let latestAwaitRuns: ReadonlyArray<SubagentRunView> = [];
  const requestedAwaitUntil = input.action === "await" ? input.until : undefined;
  const effect = Effect.gen(function* () {
    const service = yield* SubagentService;
    const consumeCompletions = (
      observations: ReadonlyArray<SubagentRunObservation>,
      fullyRenderedIds: ReadonlySet<string>,
    ) => service.consumeCompletions(renderedCompletionReceipts(observations, fullyRenderedIds));
    const finishObservations = (
      observations: ReadonlyArray<SubagentRunObservation>,
      timedOut: boolean,
    ) =>
      Effect.gen(function* () {
        const runs = observations.map((observation) => observation.run);
        const waiting = runs.filter(
          (run) => run.state === "waiting_for_parent" && run.question !== undefined,
        );
        const attentionRequired = waiting.length > 0;
        const attentionText = attentionRequired ? `${attentionRecoveryText(runs)}\n\n` : "";
        const unfinished = runs.filter((run) => !isTerminalRunState(run.state)).length;
        const timeoutText = timedOut
          ? `Await timed out; ${unfinished} subagent${unfinished === 1 ? " is" : "s are"} unfinished.\n\n`
          : "";
        const formatted = formatDetailedRuns(runs, `${timeoutText}${attentionText}`);
        yield* consumeCompletions(observations, formatted.fullyRenderedIds);
        return { runs, timedOut, attentionRequired, text: formatted.text };
      });
    const finishStatus = (ids: ReadonlyArray<string>, timedOut: boolean, attentionAware = false) =>
      service.withStatusObservations(ids, ({ observations, missingIds }) => {
        const actionFailures = missingIds.map(
          (id): SubagentActionFailure => ({
            id,
            code: "SubagentNotFoundError",
            message: `Subagent run not found: ${id}. Use subagent_list to refresh active run IDs.`,
          }),
        );
        if (attentionAware)
          return finishObservations(observations, timedOut).pipe(
            Effect.map((result) => ({ ...result, actionFailures })),
          );
        return Effect.gen(function* () {
          const runs = observations.map((observation) => observation.run);
          const failureText = formatActionFailures(actionFailures);
          const formatted = formatDetailedRuns(
            runs,
            failureText ? `${failureText}${runs.length > 0 ? "\n\n" : ""}` : "",
          );
          yield* consumeCompletions(observations, formatted.fullyRenderedIds);
          return {
            runs,
            timedOut,
            attentionRequired: false,
            text: formatted.text,
            actionFailures,
          };
        });
      });

    switch (input.action) {
      case "start": {
        const specs = yield* startSpecs(input.agents);
        let launchedRuns: ReadonlyArray<SubagentRunView> = [];
        const failureFor = (
          spec: SubagentStartSpec,
          index: number,
          error: SubagentError,
        ): SubagentStartOutcome => ({
          index,
          failure: {
            index,
            ...(spec.name?.trim() ? { name: spec.name.trim() } : {}),
            message: error.message,
            code: subagentErrorCode(error),
          },
        });
        const publishStarted = (
          request: StartSubagentRequest,
          started: SubagentRunView,
        ): Effect.Effect<void> => {
          launchedRuns = [...launchedRuns, started];
          return Effect.sync(() =>
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `Started ${launchedRuns.length} of ${specs.length} subagent${specs.length === 1 ? "" : "s"}${request.execution === "foreground" ? "; waiting for the foreground run" : ""}.`,
                },
              ],
              details: makeStartAwaitCardDetails({ action: "start", runs: launchedRuns }),
            }),
          ).pipe(
            Effect.catchDefect(() => Effect.void),
            Effect.asVoid,
          );
        };
        const resolveRequest = (spec: SubagentStartSpec) =>
          resolveProfileStart(pi, spec, ctx, runtime.environment, boundaries);
        const launchOne = (spec: SubagentStartSpec, index: number, sessionOwned = false) =>
          resolveRequest(spec).pipe(
            Effect.flatMap((request) =>
              (sessionOwned ? service.startSessionOwned(request) : service.start(request)).pipe(
                Effect.tap((started) => publishStarted(request, started)),
                Effect.map(
                  (run): SubagentStartOutcome => ({
                    index,
                    run,
                    foreground: request.execution === "foreground",
                  }),
                ),
              ),
            ),
            Effect.catch((error) => Effect.succeed(failureFor(spec, index, error))),
          );
        const summarize = (
          outcomes: ReadonlyArray<SubagentStartOutcome>,
          observation?: SubagentRunObservation,
        ) => {
          const ordered = [...outcomes].sort((left, right) => left.index - right.index);
          const launched = ordered.flatMap((outcome) =>
            "run" in outcome
              ? [
                  observation && observation.run.id === outcome.run.id
                    ? observation.run
                    : outcome.run,
                ]
              : [],
          );
          const failures = ordered.flatMap((outcome) =>
            "failure" in outcome ? [outcome.failure] : [],
          );
          if (!observation)
            return Effect.succeed({ runs: launched, startFailures: failures, timedOut: false });
          const formatted = formatStartResultDetails(launched, failures);
          return consumeCompletions([observation], formatted.fullyRenderedIds).pipe(
            Effect.as({
              runs: launched,
              startFailures: failures,
              timedOut: false,
              text: formatted.text,
            }),
          );
        };

        const foregroundIndex = specs.findIndex((spec) => spec.execution === "foreground");
        if (foregroundIndex < 0) {
          const outcomes = yield* Effect.forEach(specs, launchOne, {
            concurrency: MAX_TARGET_RUNS,
          });
          return yield* summarize(outcomes);
        }

        const foregroundSpec = specs[foregroundIndex]!;
        const resolvedForeground = yield* resolveRequest(foregroundSpec).pipe(
          Effect.match({
            onFailure: (error) => ({ failure: failureFor(foregroundSpec, foregroundIndex, error) }),
            onSuccess: (request) => ({ request }),
          }),
        );
        const otherSpecs = specs.flatMap((spec, index) =>
          index === foregroundIndex ? [] : [{ spec, index }],
        );
        if ("failure" in resolvedForeground) {
          const others = yield* Effect.forEach(
            otherSpecs,
            ({ spec, index }) => launchOne(spec, index),
            { concurrency: MAX_TARGET_RUNS },
          );
          return yield* summarize([resolvedForeground.failure, ...others]);
        }

        const foregroundRequest = resolvedForeground.request;
        const atomicForeground = service.withForegroundStartObservation(
          foregroundRequest,
          (started, awaitObservation) =>
            Effect.gen(function* () {
              yield* publishStarted(foregroundRequest, started);
              const others = yield* Effect.forEach(
                otherSpecs,
                ({ spec, index }) => launchOne(spec, index, true),
                { concurrency: MAX_TARGET_RUNS },
              );
              const observation = yield* awaitObservation;
              return yield* summarize(
                [{ index: foregroundIndex, run: started, foreground: true }, ...others],
                observation,
              );
            }),
        );
        return yield* atomicForeground.pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const others = yield* Effect.forEach(
                otherSpecs,
                ({ spec, index }) => launchOne(spec, index),
                { concurrency: MAX_TARGET_RUNS },
              );
              return yield* summarize([
                failureFor(foregroundSpec, foregroundIndex, error),
                ...others,
              ]);
            }),
          ),
        );
      }
      case "list":
        return { runs: yield* service.list, timedOut: false };
      case "status":
        return yield* finishStatus(yield* requiredTargetIds(input.action, input.runIds), false);
      case "await": {
        const ids = yield* requiredTargetIds(input.action, input.runIds);
        const until = input.until;
        let lastUpdate = "";
        const updateAwait = (runs: ReadonlyArray<SubagentRunView>) => {
          latestAwaitRuns = runs;
          const text = formatAwaitProgress(runs, until);
          if (text === lastUpdate) return;
          lastUpdate = text;
          onUpdate?.({
            content: [{ type: "text", text }],
            details: makeStartAwaitCardDetails({
              action: "await",
              runs,
              awaitUntil: until,
            }),
          });
        };
        const waiting = service.withAwaitTerminalObservations(
          ids,
          until,
          updateAwait,
          (observations) => finishObservations(observations, false),
        );
        if (input.timeoutSeconds === 0) return yield* waiting;
        const outcome = yield* waiting.pipe(
          Effect.timeoutOption(`${input.timeoutSeconds} seconds`),
        );
        if (Option.isSome(outcome)) return outcome.value;
        return yield* finishStatus(ids, true, true);
      }
      case "send": {
        const ids = yield* requiredTargetIds(input.action, input.runIds);
        const message = yield* requiredMessage(input.action, input.message);
        const outcomes = yield* Effect.forEach(
          ids,
          (id) =>
            service.send(id, message).pipe(
              Effect.match({
                onFailure: (error) => ({
                  failure: {
                    id,
                    message: error.message,
                    code: subagentErrorCode(error),
                  } satisfies SubagentActionFailure,
                }),
                onSuccess: (run) => ({ run }),
              }),
            ),
          { concurrency: 8 },
        );
        return {
          runs: outcomes.flatMap((outcome) => ("run" in outcome ? [outcome.run] : [])),
          actionFailures: outcomes.flatMap((outcome) =>
            "failure" in outcome ? [outcome.failure] : [],
          ),
          timedOut: false,
        };
      }
      case "reply": {
        const id = yield* requiredRunId(input.action, input.runId);
        const message = yield* requiredMessage(input.action, input.message);
        const outcome = yield* service.reply(id, message).pipe(
          Effect.match({
            onFailure: (error) => ({
              failure: {
                id,
                message: error.message,
                code: subagentErrorCode(error),
              } satisfies SubagentActionFailure,
            }),
            onSuccess: (run) => ({ run }),
          }),
        );
        return "run" in outcome
          ? { runs: [outcome.run], timedOut: false }
          : { runs: [], actionFailures: [outcome.failure], timedOut: false };
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
            return operation.pipe(
              Effect.match({
                onFailure: (error) => ({
                  failure: {
                    id,
                    message: error.message,
                    code: subagentErrorCode(error),
                  } satisfies SubagentActionFailure,
                }),
                onSuccess: (run) => ({ run }),
              }),
            );
          },
          { concurrency: 8 },
        );
        return {
          runs: outcomes.flatMap((outcome) => ("run" in outcome ? [outcome.run] : [])),
          actionFailures: outcomes.flatMap((outcome) =>
            "failure" in outcome ? [outcome.failure] : [],
          ),
          timedOut: false,
        };
      }
      case "rename": {
        const id = yield* requiredRunId(input.action, input.runId);
        const outcome = yield* service.rename(id, input.name.trim()).pipe(
          Effect.match({
            onFailure: (error) => ({
              failure: {
                id,
                message: error.message,
                code: subagentErrorCode(error),
              } satisfies SubagentActionFailure,
            }),
            onSuccess: (run) => ({ run }),
          }),
        );
        return "run" in outcome
          ? { runs: [outcome.run], timedOut: false }
          : { runs: [], actionFailures: [outcome.failure], timedOut: false };
      }
    }
  });

  const cancelAwait = () => {
    if (input.action !== "await" || !requestedAwaitUntil) return;
    try {
      const unfinished = latestAwaitRuns.filter((run) => !isTerminalRunState(run.state)).length;
      const attention = attentionRecoveryText(latestAwaitRuns);
      const summary =
        latestAwaitRuns.length === 0
          ? "Await cancelled before progress was observed; selected subagents may still be unfinished."
          : `Await cancelled; ${unfinished} subagent${unfinished === 1 ? " is" : "s are"} unfinished.`;
      const text = [summary, attention].filter(Boolean).join("\n\n");
      onUpdate?.({
        content: [{ type: "text", text }],
        details: makeStartAwaitCardDetails({
          action: "await",
          runs: latestAwaitRuns,
          awaitUntil: requestedAwaitUntil,
          cancelled: true,
        }),
      });
    } catch {
      // Cancellation rendering is best effort and cannot own the waiter lifecycle.
    }
  };
  if (signal?.aborted) cancelAwait();
  else signal?.addEventListener("abort", cancelAwait, { once: true });

  let executionResult: {
    readonly runs: ReadonlyArray<SubagentRunView>;
    readonly startFailures?: ReadonlyArray<SubagentStartFailure>;
    readonly actionFailures?: ReadonlyArray<SubagentActionFailure>;
    readonly timedOut: boolean;
    readonly attentionRequired?: boolean;
    readonly text?: string;
  };
  try {
    executionResult = await runtime.run(effect, signal);
  } finally {
    signal?.removeEventListener("abort", cancelAwait);
  }

  const { runs, timedOut, attentionRequired, text: formattedText } = executionResult;
  const startFailures = executionResult.startFailures ?? [];
  const actionFailures = executionResult.actionFailures ?? [];
  const details: unknown =
    input.action === "start"
      ? makeStartAwaitCardDetails({
          action: input.action,
          runs,
          ...(startFailures.length > 0 ? { startFailures } : {}),
        })
      : input.action === "await"
        ? makeStartAwaitCardDetails({
            action: input.action,
            runs,
            awaitUntil: input.until,
            ...(timedOut ? { timedOut: true } : {}),
            ...(attentionRequired ? { attentionRequired: true } : {}),
          })
        : makeCompactToolDetails({
            action: input.action,
            runs,
            ...(actionFailures.length > 0 ? { actionFailures } : {}),
            ...(timedOut ? { timedOut: true } : {}),
            ...(attentionRequired ? { attentionRequired: true } : {}),
          });
  const text =
    input.action === "start"
      ? (formattedText ?? formatStartResult(runs, startFailures))
      : actionFailures.length > 0
        ? input.action === "status"
          ? (formattedText ?? formatDetailedRuns(runs).text)
          : joinBoundedToolText([
              managementAcknowledgement(input.action, runs),
              formatActionFailures(actionFailures),
            ])
        : runs.length === 0
          ? "No subagent runs."
          : input.action === "list"
            ? runs.map((run) => formatRun(run)).join("\n")
            : input.action === "status"
              ? (formattedText ?? formatDetailedRuns(runs).text)
              : input.action === "await"
                ? (formattedText ?? formatDetailedRuns(runs).text)
                : managementAcknowledgement(input.action, runs);
  return { content: [{ type: "text", text: boundToolOutput(text) }], details };
};
