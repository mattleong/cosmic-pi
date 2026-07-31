// Pi tool execution is a Promise-shaped host boundary.
// @effect-diagnostics effect/asyncFunction:off
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import {
  hostProfileEnvironment,
  resolveProfileStart,
} from "../boundary/host-profile-resolution.ts";
import { PROFILE_IDS, type ProfileId } from "../profiles/model.ts";
import { profileCandidateLabel } from "../profiles/resolve.ts";
import { SubagentProfileService, type SubagentProfileServiceShape } from "../profiles/service.ts";
import {
  InvalidSubagentRequestError,
  subagentErrorCode,
  type SubagentError,
} from "../run/errors.ts";
import { isAssignmentFinishedRunState, type SubagentRunView } from "../run/model.ts";
import { MAX_TARGET_RUNS } from "../run/limits.ts";
import { SubagentService, type SubagentRunObservation } from "../run/service.ts";
import { runStateLabel } from "../ui/run-state.ts";
import { sanitizeTerminalLine } from "../ui/sanitize.ts";
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
  SubagentToolRuntime,
} from "./subagent.ts";

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
    for (const agent of agents) {
      const legacyField = [
        "execution",
        "context",
        "writeIntent",
        "effort",
        "backend",
        "model",
      ].find((field) => Object.prototype.hasOwnProperty.call(agent, field));
      if (legacyField)
        return yield* new InvalidSubagentRequestError({
          code: "legacy_launch_override",
          message: `[legacy_launch_override] subagent_start does not accept ${legacyField}. Put launch choices in the selected version 4 profile route.`,
        });
    }
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

const profileDiscovery = (
  input: SubagentModelsInput,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  profiles: SubagentProfileServiceShape,
): ReadonlyArray<SubagentProfileView> => {
  const ids = input.profile ? [input.profile] : PROFILE_IDS;
  const environment = hostProfileEnvironment(pi, ctx);
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
        ...(attempt ? { effectiveContext: attempt.effectiveContext } : {}),
        reason: attempt
          ? "Candidate adapter is statically eligible before native authentication/integration/harness readiness."
          : (omitted?.reason ?? "Candidate was not eligible."),
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
    "Profile routes · static preflight",
    `Default profile: ${defaultProfile}`,
    "Each candidate lists host/runtime/model, effort, context, write intent, and closeOnReport.",
    "Launch-time executable, authentication, integration, and private-harness checks are not included here.",
    "",
    ...profiles.flatMap((profile) => [
      `${profile.id} — ${profile.description}`,
      `  defaults · context=${profile.defaultContext} · intent=${profile.defaultWriteIntent} · effort=${profile.defaultEffort ?? "inherit"}`,
      ...(profile.candidates.length > 0
        ? profile.candidates.map(
            (candidate) =>
              `  ${candidate.order}. ${candidate.candidate} · ${candidate.status}${candidate.effectiveContext ? ` · context=${candidate.effectiveContext}` : ""}\n     ${candidate.reason}`,
          )
        : ["  disabled · no candidates"]),
      "",
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
): Promise<AgentToolResult<unknown>> => {
  if (input.action === "models") {
    const discovery = Effect.gen(function* () {
      const profileService = yield* SubagentProfileService;
      const profiles = profileDiscovery(input, pi, ctx, profileService);
      return {
        content: [
          {
            type: "text" as const,
            text: boundToolOutput(
              formatProfileDiscovery(profiles, profileService.config.defaultProfile),
            ),
          },
        ],
        details: makeCompactToolDetails({
          action: input.action,
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
    const finishObservations = (observations: ReadonlyArray<SubagentRunObservation>) =>
      Effect.gen(function* () {
        const runs = observations.map((observation) => observation.run);
        const waiting = runs.filter(
          (run) => run.state === "waiting_for_parent" && run.question !== undefined,
        );
        const attentionRequired = waiting.length > 0;
        const attentionText = attentionRequired ? `${attentionRecoveryText(runs)}\n\n` : "";
        const formatted = formatDetailedRuns(runs, attentionText);
        yield* consumeCompletions(observations, formatted.fullyRenderedIds);
        return { runs, attentionRequired, text: formatted.text };
      });
    const finishStatus = (ids: ReadonlyArray<string>) =>
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
          const attentionText = attentionRecoveryText(runs);
          const prefix = [failureText, attentionText].filter(Boolean).join("\n\n");
          const formatted = formatDetailedRuns(runs, prefix ? `${prefix}\n\n` : "");
          yield* consumeCompletions(observations, formatted.fullyRenderedIds);
          return {
            runs,
            attentionRequired: attentionText.length > 0,
            text: formatted.text,
            actionFailures,
          };
        });
      });

    switch (input.action) {
      case "start": {
        const specs = yield* startSpecs(input.agents);
        const partialOutcomes = new Map<number, SubagentStartOutcome>();
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
              details: makeStartAwaitCardDetails({
                action: "start",
                runs: launched,
                ...(failures.length > 0 ? { startFailures: failures } : {}),
              }),
            }),
          ).pipe(
            Effect.catchDefect(() => Effect.void),
            Effect.asVoid,
          );
        };
        const resolveRequest = (spec: SubagentStartSpec) =>
          resolveProfileStart(pi, spec, ctx, runtime.environment);
        const launchOne = (spec: SubagentStartSpec, index: number) =>
          resolveRequest(spec).pipe(
            Effect.flatMap((request) =>
              service.startSessionOwned(request).pipe(
                Effect.map(
                  (run): SubagentStartOutcome => ({
                    index,
                    run,
                  }),
                ),
              ),
            ),
            Effect.catch((error) => Effect.succeed(failureFor(spec, index, error))),
            Effect.tap(publishOutcome),
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
          if (!observation) return Effect.succeed({ runs: launched, startFailures: failures });
          const formatted = formatStartResultDetails(launched, failures);
          return consumeCompletions([observation], formatted.fullyRenderedIds).pipe(
            Effect.as({
              runs: launched,
              startFailures: failures,
              text: formatted.text,
            }),
          );
        };

        const outcomes = yield* Effect.forEach(specs, launchOne, {
          concurrency: MAX_TARGET_RUNS,
        });
        return yield* summarize(outcomes);
      }
      case "list":
        return { runs: yield* service.list };
      case "status":
        return yield* finishStatus(yield* requiredTargetIds(input.action, input.runIds));
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
          ? { runs: [outcome.run] }
          : { runs: [], actionFailures: [outcome.failure] };
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
          ? { runs: [outcome.run] }
          : { runs: [], actionFailures: [outcome.failure] };
      }
    }
  });

  const cancelAwait = () => {
    if (input.action !== "await" || !requestedAwaitUntil) return;
    try {
      const unfinished = latestAwaitRuns.filter(
        (run) => !isAssignmentFinishedRunState(run.state),
      ).length;
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
    readonly attentionRequired?: boolean;
    readonly text?: string;
  };
  try {
    executionResult = await runtime.run(effect, signal);
  } finally {
    signal?.removeEventListener("abort", cancelAwait);
  }

  const { runs, attentionRequired, text: formattedText } = executionResult;
  const startFailures = executionResult.startFailures ?? [];
  const actionFailures = executionResult.actionFailures ?? [];
  const details: unknown =
    input.action === "start"
      ? makeStartAwaitCardDetails({
          action: "start",
          runs,
          ...(startFailures.length > 0 ? { startFailures } : {}),
        })
      : input.action === "await"
        ? makeStartAwaitCardDetails({
            action: input.action,
            runs,
            awaitUntil: input.until,
            ...(attentionRequired ? { attentionRequired: true } : {}),
          })
        : makeCompactToolDetails({
            action: input.action,
            runs,
            ...(actionFailures.length > 0 ? { actionFailures } : {}),
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
