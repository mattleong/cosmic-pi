import { sanitizeTerminalLine, type JsonObject } from "pi-cosmic-core";
import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import {
  resolveProfileStart,
  type SubagentSessionEnvironment,
} from "../boundary/host-profile-resolution.ts";
import type { SubagentSelectionProvenance } from "../profiles/model.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import type { SubagentBackendRegistry } from "../backend/service.ts";
import {
  InvalidSubagentRequestError,
  subagentErrorCode,
  type SubagentError,
} from "../run/errors.ts";
import type { StartSubagentRequest, SubagentRunView } from "../run/model.ts";
import { MAX_START_BATCH } from "../run/limits.ts";
import { getFailedStartRecovery } from "../run/launch.ts";
import {
  disallowedLaunchOverrideMessage,
  firstDisallowedLaunchOverride,
} from "../run/launch-validation.ts";
import { makeStartDetails } from "./details.ts";
import type { SubagentStartEntry } from "./details-schema.ts";
import type {
  SubagentStartFailure,
  SubagentStartOutcome,
  SubagentStartResolvedRoute,
} from "./model.ts";
import type { SubagentStartSpec } from "./schema.ts";

export interface StartBatchInput {
  readonly agents: ReadonlyArray<SubagentStartSpec>;
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext;
  readonly environment: SubagentSessionEnvironment;
  /** Session-owned launch path; the tool runtime decides root versus proxied caller. */
  readonly startOwned: (
    request: StartSubagentRequest,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly onUpdate: AgentToolUpdateCallback<unknown> | undefined;
  /** Initial native codemode workflows coordinate read-only assignments only. */
  readonly readOnly?: boolean;
}

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
    return agents;
  });

const entryName = (spec: SubagentStartSpec, index: number): string =>
  sanitizeTerminalLine(spec.name?.trim() || `launch ${index + 1}`);

/** Shared selected-route projection for started runs, resolved failures, and request routes. */
const routeFields = (
  source: Pick<StartSubagentRequest, "host" | "runtime" | "model" | "effort" | "openaiFastMode">,
  selection?: Pick<SubagentSelectionProvenance, "candidateIndex" | "warning"> | undefined,
) => ({
  host: source.host,
  runtime: source.runtime,
  model: source.model,
  effort: source.effort,
  openaiFastMode: source.openaiFastMode,
  ...(selection?.candidateIndex !== undefined && { candidateIndex: selection.candidateIndex }),
  ...(selection?.warning !== undefined &&
    selection.warning.length > 0 && {
      warning: selection.warning,
    }),
});

const routeForRequest = (request: StartSubagentRequest): SubagentStartResolvedRoute => ({
  profile: request.profile ?? "generalist",
  ...routeFields(request, request.selection),
});

const startEntriesFor = (
  specs: ReadonlyArray<SubagentStartSpec>,
  outcomes: ReadonlyMap<number, SubagentStartOutcome>,
): ReadonlyArray<SubagentStartEntry> =>
  specs.map((spec, index): SubagentStartEntry => {
    const base = {
      index,
      name: entryName(spec, index),
      profile: sanitizeTerminalLine(spec.profile?.trim() || "generalist"),
    } as const;
    const outcome = outcomes.get(index);
    if (!outcome) return { ...base, status: "pending", routeStatus: "resolving" };
    if ("run" in outcome)
      return {
        ...base,
        profile: outcome.run.profile ?? base.profile,
        status: "started" as const,
        routeStatus: "selected" as const,
        ...routeFields(outcome.run, outcome.run.selection),
        runId: outcome.run.id,
        cwd: outcome.run.cwd,
        ...(outcome.run.writerWorkspaceMode !== undefined && {
          writerWorkspaceMode: outcome.run.writerWorkspaceMode,
        }),
        ...(outcome.run.workspaceId !== undefined && { workspaceId: outcome.run.workspaceId }),
        ...(outcome.run.sourceCwd !== undefined && { sourceCwd: outcome.run.sourceCwd }),
      };
    if (outcome.resolvedRoute)
      return {
        ...base,
        profile: outcome.resolvedRoute.profile,
        status: "failed" as const,
        routeStatus: "selected" as const,
        ...routeFields(outcome.resolvedRoute, outcome.resolvedRoute),
      };
    return { ...base, status: "failed" as const, routeStatus: "unavailable" as const };
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

const settleStartOutcomes = (outcomes: Iterable<SubagentStartOutcome>) => {
  const ordered = [...outcomes].sort((left, right) => left.index - right.index);
  return {
    ordered,
    launched: ordered.flatMap((outcome) => ("run" in outcome ? [outcome.run] : [])),
    failures: ordered.flatMap((outcome) => ("failure" in outcome ? [outcome.failure] : [])),
  };
};

/** Scripted workflows admit only resolved read-only routes. */
const admissionError = (
  request: StartSubagentRequest,
  readOnly: boolean,
): InvalidSubagentRequestError | undefined =>
  readOnly && request.writeIntent !== "read-only"
    ? new InvalidSubagentRequestError({
        code: "scripted_writer_not_supported",
        message:
          "Codemode scripts can only start read-only agents\n\nStart writers from the main agent directly or inside a subagent_workflow script.",
      })
    : undefined;

/** Runs the batch, publishing hostile-input-proof partial receipts in request order. */
export const executeStartBatch = (
  input: StartBatchInput,
): Effect.Effect<
  {
    readonly runs: ReadonlyArray<SubagentRunView>;
    readonly startFailures: ReadonlyArray<SubagentStartFailure>;
    readonly startEntries: ReadonlyArray<SubagentStartEntry>;
    readonly startOutcomes: ReadonlyArray<SubagentStartOutcome>;
  },
  SubagentError,
  SubagentProfileService | SubagentBackendRegistry
> =>
  Effect.gen(function* () {
    const specs = yield* startSpecs(input.agents);
    const profileService = yield* SubagentProfileService;
    const profileSnapshot = yield* profileService.capture;
    const partialOutcomes = new Map<number, SubagentStartOutcome>();
    const publishOutcome = (outcome: SubagentStartOutcome): Effect.Effect<void> => {
      partialOutcomes.set(outcome.index, outcome);
      const { ordered, launched, failures } = settleStartOutcomes(partialOutcomes.values());
      const pendingEntries = specs.flatMap((spec, index) =>
        partialOutcomes.has(index) ? [] : [`#${index + 1} ${entryName(spec, index)}`],
      );
      const summary = `Processed ${ordered.length} of ${specs.length} launches · ${launched.length} started · ${failures.length} failed${pendingEntries.length > 0 ? ` · ${pendingEntries.length} pending (${pendingEntries.join(", ")})` : ""}.`;
      return Effect.sync(() =>
        input.onUpdate?.({
          content: [{ type: "text", text: summary }],
          details: makeStartDetails({
            startEntries: startEntriesFor(specs, partialOutcomes),
            ...(failures.length > 0 && { startFailures: failures }),
          }),
        }),
      ).pipe(
        Effect.catchDefect(() => Effect.void),
        Effect.asVoid,
      );
    };
    const resolveRequest = (spec: SubagentStartSpec) =>
      resolveProfileStart(input.pi, spec, input.ctx, input.environment, profileSnapshot).pipe(
        Effect.map((request) => ({
          ...request,
          nestingPolicy: profileSnapshot.effectiveConfig.nesting,
          nestingPolicyRevision: profileSnapshot.revision,
        })),
      );
    const launchOne = (spec: SubagentStartSpec, index: number) =>
      resolveRequest(spec).pipe(
        Effect.flatMap((request) => {
          const rejected = admissionError(request, input.readOnly === true);
          return (rejected ? Effect.fail(rejected) : input.startOwned(request)).pipe(
            Effect.map((run): SubagentStartOutcome => ({ index, run })),
            Effect.catch((error) =>
              Effect.succeed(failureFor(spec, index, error, routeForRequest(request))),
            ),
          );
        }),
        Effect.catch((error) => Effect.succeed(failureFor(spec, index, error))),
        Effect.tap(publishOutcome),
      );
    const outcomes = yield* Effect.forEach(specs, launchOne, { concurrency: MAX_START_BATCH });
    const { ordered, launched, failures } = settleStartOutcomes(outcomes);
    return {
      runs: launched,
      startFailures: failures,
      startEntries: startEntriesFor(specs, new Map(ordered.map((o) => [o.index, o]))),
      startOutcomes: ordered,
    };
  });
