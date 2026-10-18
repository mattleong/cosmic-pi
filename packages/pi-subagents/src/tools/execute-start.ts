import { invokeBestEffort, sanitizeTerminalLine } from "pi-cosmic-core";
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
import { capturePiParentContext } from "../boundary/host-child-pi.ts";
import type { SubagentSelectionProvenance } from "../profiles/model.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import type { SubagentBackendRegistry } from "../backend/service.ts";
import {
  invalidRequest,
  subagentErrorCode,
  type InvalidSubagentRequestError,
  type SubagentError,
} from "../run/errors.ts";
import type { StartSubagentRequest, SubagentRunView } from "../run/model.ts";
import { MAX_START_BATCH } from "../run/limits.ts";
import { getFailedStartRecovery } from "../run/launch.ts";
import {
  disallowedLaunchOverrideMessage,
  firstDisallowedLaunchOverride,
} from "../run/launch-validation.ts";
import { startDetails } from "./details.ts";
import { projectModelOverride } from "./details-projection.ts";
import type { SubagentStartEntry } from "./details-schema.ts";
import type {
  SubagentStartFailure,
  SubagentStartOutcome,
  SubagentStartResolvedRoute,
} from "./model.ts";
import type { SubagentStartSpec } from "./schema.ts";
import type { WorkspaceLaunch } from "../workspace/model.ts";

interface StartBatchInput {
  readonly agents: ReadonlyArray<SubagentStartSpec>;
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext;
  readonly environment: SubagentSessionEnvironment;
  readonly startOwned: (
    request: StartSubagentRequest,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly onUpdate: AgentToolUpdateCallback<unknown> | undefined;
  readonly readOnly?: boolean;
}

const startSpecs = (
  agents: ReadonlyArray<SubagentStartSpec>,
): Effect.Effect<ReadonlyArray<SubagentStartSpec>, InvalidSubagentRequestError> =>
  Effect.gen(function* () {
    if (agents.length === 0 || agents.length > MAX_START_BATCH)
      return yield* invalidRequest(
        "agent_count_invalid",
        `subagent_start requires between 1 and ${MAX_START_BATCH} agents.`,
      );
    for (const agent of agents) {
      const disallowedField = firstDisallowedLaunchOverride(agent);
      if (disallowedField)
        return yield* invalidRequest(
          "launch_override_not_allowed",
          disallowedLaunchOverrideMessage(disallowedField),
        );
    }
    return agents;
  });

const entryName = (spec: SubagentStartSpec, index: number): string =>
  sanitizeTerminalLine((spec.name?.trim() ?? "") || `launch ${index + 1}`);

const routeFields = (
  source: Pick<
    StartSubagentRequest,
    "runtime" | "model" | "effort" | "openaiFastMode" | "modelOverride"
  >,
  selection?: Pick<SubagentSelectionProvenance, "candidateIndex" | "warning">,
) => ({
  runtime: source.runtime,
  model: source.model,
  effort: source.effort,
  openaiFastMode: source.openaiFastMode,
  ...projectModelOverride(source.modelOverride),
  ...(selection?.candidateIndex !== undefined && { candidateIndex: selection.candidateIndex }),
  ...(selection?.warning && { warning: selection.warning }),
});

const routeForRequest = (request: StartSubagentRequest): SubagentStartResolvedRoute => ({
  profile: request.profile ?? "generalist",
  ...(request.agent && { agent: request.agent }),
  ...routeFields(request, request.selection),
});

const startEntriesFor = (
  specs: ReadonlyArray<SubagentStartSpec>,
  outcomes: ReadonlyMap<number, SubagentStartOutcome>,
): ReadonlyArray<SubagentStartEntry> =>
  specs.map((spec, index): SubagentStartEntry => {
    const agent = spec.agent?.trim();
    const base = {
      index,
      name: entryName(spec, index),
      profile: sanitizeTerminalLine((spec.profile?.trim() ?? "") || "generalist"),
      ...(agent && { agent: sanitizeTerminalLine(agent) }),
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
  const ordered = [...outcomes].toSorted((left, right) => left.index - right.index);
  return {
    ordered,
    launched: ordered.flatMap((outcome) => ("run" in outcome ? [outcome.run] : [])),
    failures: ordered.flatMap((outcome) => ("failure" in outcome ? [outcome.failure] : [])),
  };
};

const admissionError = (
  request: StartSubagentRequest,
  readOnly: boolean,
): InvalidSubagentRequestError | undefined =>
  readOnly && request.writeIntent !== "read-only"
    ? invalidRequest(
        "scripted_writer_not_supported",
        "Codemode scripts can only start read-only agents\n\nStart writers from the main agent directly.",
      )
    : undefined;

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
    const environment = {
      ...input.environment,
      parentContext: input.environment.parentContext ?? capturePiParentContext(input.pi, input.ctx),
    };
    const partialOutcomes = new Map<number, SubagentStartOutcome>();
    const publishOutcome = (outcome: SubagentStartOutcome) =>
      Effect.sync(() => {
        partialOutcomes.set(outcome.index, outcome);
        const { ordered, launched, failures } = settleStartOutcomes(partialOutcomes.values());
        const pendingEntries = specs.flatMap((spec, index) =>
          partialOutcomes.has(index) ? [] : [`#${index + 1} ${entryName(spec, index)}`],
        );
        const summary = `Processed ${ordered.length} of ${specs.length} launches · ${launched.length} started · ${failures.length} failed${pendingEntries.length > 0 ? ` · ${pendingEntries.length} pending (${pendingEntries.join(", ")})` : ""}.`;
        invokeBestEffort(() =>
          input.onUpdate?.({
            content: [{ type: "text", text: summary }],
            details: startDetails({
              startEntries: startEntriesFor(specs, partialOutcomes),
              ...(failures.length > 0 && { startFailures: failures }),
            }),
          }),
        );
      });
    const resolveRequest = (spec: SubagentStartSpec) =>
      resolveProfileStart(input.pi, spec, input.ctx, environment, profileSnapshot).pipe(
        Effect.map((request) => ({
          ...request,
          nestingPolicy: profileSnapshot.effectiveConfig.nesting,
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
    yield* Effect.forEach(specs, launchOne, { concurrency: MAX_START_BATCH, discard: true });
    const { ordered, launched, failures } = settleStartOutcomes(partialOutcomes.values());
    return {
      runs: launched,
      startFailures: failures,
      startEntries: startEntriesFor(specs, partialOutcomes),
      startOutcomes: ordered,
    };
  });

/**
 * Resolves an adopted workspace's recorded launch like a worktree writer start item with `task`,
 * so its revision successor runs the profile or custom agent its original writer did. An agent
 * this session no longer configures, or that fails closed, can't be relaunched.
 */
export const resolveRecordedLaunch = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  environment: SubagentSessionEnvironment,
  launch: WorkspaceLaunch,
  task: string,
): Effect.Effect<
  StartSubagentRequest,
  InvalidSubagentRequestError,
  SubagentProfileService | SubagentBackendRegistry
> =>
  Effect.gen(function* () {
    const profileSnapshot = yield* (yield* SubagentProfileService).capture;
    const route =
      launch.agent === undefined ? { profile: launch.profile } : { agent: launch.agent };
    const request = yield* resolveProfileStart(
      pi,
      { task, ...route, name: launch.name, isolation: "worktree" },
      ctx,
      {
        ...environment,
        parentContext: environment.parentContext ?? capturePiParentContext(pi, ctx),
      },
      profileSnapshot,
    ).pipe(
      Effect.catchIf(
        (error) => error.code === "agent_unknown" || error.code === "agent_invalid",
        () =>
          Effect.fail(
            invalidRequest(
              "workspace_launch_unavailable",
              `This workspace's writer was started as custom agent ${sanitizeTerminalLine(launch.agent ?? "")}, which this session no longer configures. Apply or discard the workspace, or start a new writer.`,
            ),
          ),
      ),
    );
    return { ...request, nestingPolicy: profileSnapshot.effectiveConfig.nesting };
  });
