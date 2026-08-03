import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { SubagentBackendRegistry } from "../backend/service.ts";
import { ORCHESTRATION_TOOL_DENYLIST, piToolsForWriteIntent } from "../run/coordination.ts";
import { InvalidSubagentRequestError } from "../run/errors.ts";
import { supportsSubagentFastMode } from "../run/fast-mode.ts";
import { resolvePiModelSelector } from "../run/model-catalog.ts";
import {
  decodeSubagentEffort,
  type StartSubagentRequest,
  type SubagentEffort,
  type SubagentHost,
  type SubagentRuntime,
} from "../run/model.ts";
import {
  PROFILE_IDS,
  type SkippedProfileCandidate,
  type SubagentSelectionProvenance,
} from "../profiles/model.ts";
import type { ProfileCandidateAttempt, ProfileResolutionEnvironment } from "../profiles/resolve.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import type { SessionProfileSnapshot } from "../profiles/session-overrides.ts";

export interface SubagentProfileStartSpec {
  readonly task: string;
  readonly name?: string | undefined;
  readonly profile?: string | undefined;
}

export interface SubagentSessionEnvironment {
  readonly cwd: string;
  readonly projectTrusted: boolean;
}

const stableParentLeaf = (ctx: ExtensionContext): string | undefined => {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (!leaf) return undefined;
  if (leaf.type === "message" && leaf.message.role === "assistant")
    return leaf.parentId ?? undefined;
  return leaf.id;
};

const transferableRuntimeApiKey = (value: string | undefined): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 8_192 &&
  !value.includes("\0") &&
  !value.includes("\r") &&
  !value.includes("\n");

const resolvePiModel = (
  host: SubagentHost,
  selector: string,
  effort: SubagentEffort,
  effortWasExplicit: boolean,
  ctx: ExtensionContext,
): Effect.Effect<
  { readonly model: string; readonly runtimeApiKey?: string | undefined },
  InvalidSubagentRequestError
> =>
  Effect.gen(function* () {
    const resolution = resolvePiModelSelector(
      selector,
      ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id })),
    );
    if (resolution.kind === "ambiguous")
      return yield* new InvalidSubagentRequestError({
        code: "pi_model_ambiguous",
        message: `Pi model "${selector}" matches multiple authenticated providers: ${resolution.candidates.join(", ")}. Configure one canonical provider/model value.`,
      });
    if (resolution.kind === "unknown")
      return yield* new InvalidSubagentRequestError({
        code: "pi_model_unknown",
        message: `Profile route references unknown or unauthenticated Pi model "${selector}".${resolution.nearMatches.length > 0 ? ` Close authenticated matches: ${resolution.nearMatches.join(", ")}.` : ""} Update the profile route and reload.`,
      });
    const modelId = `${resolution.provider}/${resolution.id}`;
    const model = ctx.modelRegistry.find(resolution.provider, resolution.id);
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model))
      return yield* new InvalidSubagentRequestError({
        code: "pi_model_unauthenticated",
        message: `Model is unavailable or unauthenticated: ${modelId}`,
      });
    const supportedEfforts = getSupportedThinkingLevels(model) as ReadonlyArray<SubagentEffort>;
    if (effortWasExplicit && !supportedEfforts.includes(effort))
      return yield* new InvalidSubagentRequestError({
        code: "pi_effort_unsupported",
        message: `Pi model ${modelId} does not support required effort ${effort}; supported efforts: ${supportedEfforts.join(", ") || "none"}.`,
      });
    const authSource = ctx.modelRegistry.getProviderAuthStatus(model.provider).source;
    const requiresPrivateTransfer =
      authSource === "runtime" || (host === "herdr" && authSource === "environment");
    if (!requiresPrivateTransfer) return { model: modelId };
    const auth = yield* Effect.tryPromise({
      try: () => ctx.modelRegistry.getApiKeyAndHeaders(model),
      catch: () =>
        new InvalidSubagentRequestError({
          code: "pi_auth_resolution_failed",
          message: `Unable to resolve runtime authentication for ${modelId}.`,
        }),
    });
    if (!auth.ok || !transferableRuntimeApiKey(auth.apiKey))
      return yield* new InvalidSubagentRequestError({
        code: "pi_auth_unavailable",
        message: `Transferable runtime authentication is unavailable for ${modelId}.`,
      });
    return { model: modelId, runtimeApiKey: auth.apiKey };
  });

interface ResolvedConcreteModel {
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
  readonly closeOnReport: boolean;
  readonly fastMode: boolean;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly effortWasExplicit: boolean;
  readonly runtimeApiKey?: string | undefined;
}

/** Unknown host values clamp to the existing conservative inheritance default. */
const inheritedParentEffort = (pi: ExtensionAPI): SubagentEffort =>
  decodeSubagentEffort(pi.getThinkingLevel()) ?? "high";

export const hostProfileEnvironment = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): ProfileResolutionEnvironment => ({
  availablePiModels: ctx.modelRegistry.getAvailable().map((model) => ({
    provider: model.provider,
    id: model.id,
    supportedEfforts: getSupportedThinkingLevels(model) as ReadonlyArray<SubagentEffort>,
  })),
  ...(ctx.model
    ? {
        parentModel: {
          model: `${ctx.model.provider}/${ctx.model.id}`,
          effort: inheritedParentEffort(pi),
        },
      }
    : {}),
  forkAvailable: Boolean(ctx.sessionManager.getSessionFile() && stableParentLeaf(ctx)),
});

const resolveConcreteModel = (
  attempt: ProfileCandidateAttempt,
  ctx: ExtensionContext,
  cwd: string,
): Effect.Effect<ResolvedConcreteModel, InvalidSubagentRequestError, SubagentBackendRegistry> =>
  Effect.gen(function* () {
    const registry = yield* SubagentBackendRegistry;
    const resolved =
      attempt.runtime === "pi"
        ? yield* resolvePiModel(
            attempt.host,
            attempt.model,
            attempt.effort,
            attempt.effortWasExplicit,
            ctx,
          )
        : { model: attempt.model };
    if (attempt.fastMode && !supportsSubagentFastMode(attempt.runtime, resolved.model))
      return yield* new InvalidSubagentRequestError({
        code: "fast_mode_unsupported",
        message: `Fast mode is unavailable for ${attempt.runtime}/${resolved.model}.`,
      });
    yield* registry.preflight(
      {
        host: attempt.host,
        runtime: attempt.runtime,
        context: attempt.effectiveContext,
      },
      {
        context: attempt.effectiveContext,
        writeIntent: attempt.writeIntent,
        closeOnReport: attempt.closeOnReport,
        model: resolved.model,
        effort: attempt.effort,
        cwd,
      },
    );
    return {
      host: attempt.host,
      runtime: attempt.runtime,
      closeOnReport: attempt.closeOnReport,
      fastMode: attempt.fastMode,
      ...resolved,
      effort: attempt.effort,
      effortWasExplicit: attempt.effortWasExplicit,
    };
  });

const dynamicCandidateSkip = (
  attempt: ProfileCandidateAttempt,
  error: { readonly message: string; readonly _tag: string; readonly code?: string | undefined },
): SkippedProfileCandidate => ({
  candidateIndex: attempt.candidateIndex,
  candidate: `${attempt.host}/${attempt.runtime}/${attempt.model}:${attempt.effort}`,
  code: error.code || error._tag,
  reason: error.message,
});

const LEGACY_LAUNCH_FIELDS = [
  "execution",
  "context",
  "writeIntent",
  "effort",
  "backend",
  "model",
] as const;

export const resolveProfileStart = (
  pi: ExtensionAPI,
  rawInput: SubagentProfileStartSpec,
  ctx: ExtensionContext,
  environment: SubagentSessionEnvironment,
  capturedProfiles?: SessionProfileSnapshot,
): Effect.Effect<
  StartSubagentRequest,
  InvalidSubagentRequestError,
  SubagentProfileService | SubagentBackendRegistry
> =>
  Effect.gen(function* () {
    const profiles = yield* SubagentProfileService;
    const profileSnapshot = capturedProfiles ?? (yield* profiles.capture);
    const task = rawInput.task.trim();
    if (!task)
      return yield* new InvalidSubagentRequestError({
        code: "task_required",
        message: "subagent_start requires every agent to have a task.",
      });
    const legacyField = LEGACY_LAUNCH_FIELDS.find((field) =>
      Object.prototype.hasOwnProperty.call(rawInput, field),
    );
    if (legacyField)
      return yield* new InvalidSubagentRequestError({
        code: "legacy_launch_override",
        message: `[legacy_launch_override] subagent_start does not accept ${legacyField}. Put host, runtime, model, effort, context, writeIntent, and closeOnReport in the selected version 4 profile route.`,
      });

    const requestedProfile = rawInput.profile?.trim();
    const selectedProfile = requestedProfile || "generalist";
    const definition = profiles.definition(selectedProfile);
    if (!definition)
      return yield* new InvalidSubagentRequestError({
        code: "profile_unknown",
        message: `Unknown subagent profile "${selectedProfile}". Available profiles: ${PROFILE_IDS.join(", ")}.`,
      });
    const parentSessionFile = ctx.sessionManager.getSessionFile();
    const parentLeafId = stableParentLeaf(ctx);
    const plan = profiles.resolve(profileSnapshot, definition.id, hostProfileEnvironment(pi, ctx));
    if (plan.kind === "failed")
      return yield* new InvalidSubagentRequestError({ code: plan.code, message: plan.message });

    const tryAttempt = (
      index: number,
      skippedCandidates: ReadonlyArray<SkippedProfileCandidate>,
    ): Effect.Effect<
      {
        readonly attempt: ProfileCandidateAttempt;
        readonly concrete: ResolvedConcreteModel;
        readonly selection: SubagentSelectionProvenance;
      },
      InvalidSubagentRequestError,
      SubagentBackendRegistry
    > => {
      const attempt = plan.attempts[index];
      if (!attempt) {
        const exhausted = [...skippedCandidates, ...plan.trailingSkippedCandidates];
        const allUnsupported =
          exhausted.length > 0 &&
          exhausted.every((candidate) => candidate.code === "backend_not_implemented");
        const skipCodes = exhausted
          .map(
            (candidate) =>
              `${candidate.candidateIndex === undefined ? "route" : `candidate ${candidate.candidateIndex + 1}`}[${candidate.code}]`,
          )
          .join(", ");
        return Effect.fail(
          new InvalidSubagentRequestError({
            code: allUnsupported ? "backend_not_implemented" : "profile_no_eligible_model",
            message: `Profile ${definition.id} has no eligible implemented backend after pre-start checks.${skipCodes ? ` Skipped: ${skipCodes}.` : ""}${exhausted.length > 0 ? ` ${exhausted.map((candidate) => candidate.reason).join(" ")}` : ""}`,
          }),
        );
      }
      const precedingSkips = [...skippedCandidates, ...(attempt.skippedBefore ?? [])];
      return resolveConcreteModel(attempt, ctx, environment.cwd).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            error.code?.includes("cleanup_unconfirmed") === true ||
            error.code?.includes("outcome_uncertain") === true
              ? Effect.fail(error)
              : tryAttempt(index + 1, [...precedingSkips, dynamicCandidateSkip(attempt, error)]),
          onSuccess: (concrete) =>
            Effect.succeed({
              attempt,
              concrete,
              selection: {
                source: attempt.source,
                routeSource: attempt.routeSource,
                host: attempt.host,
                runtime: attempt.runtime,
                closeOnReport: attempt.closeOnReport,
                candidateIndex: attempt.candidateIndex,
                reason: attempt.reason,
                skippedCandidates: precedingSkips,
              },
            }),
        }),
      );
    };

    const selected = yield* tryAttempt(0, []);
    if (selected.attempt.effectiveContext === "fork" && (!parentSessionFile || !parentLeafId))
      return yield* new InvalidSubagentRequestError({
        code: "fork_context_unavailable",
        message: "Forked context requires a persisted parent session with a stable leaf.",
      });
    const concrete = selected.concrete;
    return {
      ...(rawInput.name?.trim() ? { name: rawInput.name.trim() } : {}),
      host: concrete.host,
      runtime: concrete.runtime,
      closeOnReport: concrete.closeOnReport,
      fastMode: concrete.fastMode,
      backend: "pi",
      task,
      profile: definition.id,
      profileGuidance: definition.guidance,
      selection: selected.selection,
      cwd: environment.cwd,
      execution: "background",
      context: selected.attempt.effectiveContext,
      writeIntent: selected.attempt.writeIntent,
      model: concrete.model,
      ...(concrete.runtimeApiKey ? { runtimeApiKey: concrete.runtimeApiKey } : {}),
      effort: concrete.effort,
      effortWasExplicit: concrete.effortWasExplicit,
      activeTools: piToolsForWriteIntent(
        pi.getActiveTools().filter((name) => !ORCHESTRATION_TOOL_DENYLIST.has(name)),
        selected.attempt.writeIntent,
      ),
      projectTrusted: environment.projectTrusted,
      parentSessionId: ctx.sessionManager.getSessionId(),
      ...(parentSessionFile ? { parentSessionFile } : {}),
      ...(parentLeafId ? { parentLeafId } : {}),
    } satisfies StartSubagentRequest;
  });
