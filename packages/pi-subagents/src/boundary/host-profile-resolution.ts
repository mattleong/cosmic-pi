import * as Predicate from "effect/Predicate";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { SubagentBackendRegistry } from "../backend/service.ts";
import { ORCHESTRATION_TOOL_DENYLIST, piToolsForWriteIntent } from "../run/tool-policy.ts";
import {
  disallowedLaunchOverrideMessage,
  firstDisallowedLaunchOverride,
} from "../run/launch-validation.ts";
import {
  InvalidSubagentRequestError,
  isCleanupUnconfirmed,
  isOutcomeUncertain,
} from "../run/errors.ts";
import { supportsSubagentFastMode } from "../run/fast-mode.ts";
import { resolvePiModelSelector } from "../run/model-catalog.ts";
import {
  decodeSubagentEffort,
  type SubagentEffort,
  type SubagentHost,
  type SubagentRuntime,
} from "../domain/routing.ts";
import type { StartSubagentRequest } from "../run/model.ts";
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
  Predicate.isString(value) &&
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
    const extensionProviders =
      host === "herdr"
        ? yield* Effect.try({
            try: () => new Set(ctx.modelRegistry.getRegisteredProviderIds()),
            catch: () =>
              new InvalidSubagentRequestError({
                code: "herdr_pi_provider_provenance_unavailable",
                message:
                  "Unable to verify Pi provider provenance for sterile Herdr launch; choose another candidate or retry after the model registry is available.",
              }),
          })
        : undefined;
    const selectorSlash = selector.indexOf("/");
    const selectorProvider = selectorSlash > 0 ? selector.slice(0, selectorSlash) : undefined;
    if (selectorProvider && extensionProviders?.has(selectorProvider))
      return yield* new InvalidSubagentRequestError({
        code: "herdr_pi_extension_provider_unavailable",
        message: `Herdr Pi disables extension discovery, so extension-registered provider "${selectorProvider}" cannot be loaded. Choose a non-extension Pi provider or use local Pi.`,
      });
    const availableModels = ctx.modelRegistry
      .getAvailable()
      .filter((model) => !extensionProviders?.has(model.provider))
      .map((model) => ({ provider: model.provider, id: model.id }));
    const resolution = resolvePiModelSelector(selector, availableModels);
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
    // SAFETY: The boundary adapter's ownership and validation checks establish this host contract before use.
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

// SAFETY: The boundary adapter's ownership and validation checks establish this host contract before use.
export const hostProfileEnvironment = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): ProfileResolutionEnvironment =>
  (() => {
    const objectPart6996_0 = {
      availablePiModels: ctx.modelRegistry.getAvailable().map((model) => ({
        provider: model.provider,
        id: model.id,
        supportedEfforts: getSupportedThinkingLevels(model).flatMap((effort) => {
          const decoded = decodeSubagentEffort(effort);
          return decoded === undefined ? [] : [decoded];
        }),
      })),
    };
    const objectPart6996_1 = ctx.model
      ? {
          ...objectPart6996_0,
          parentModel: {
            model: `${ctx.model.provider}/${ctx.model.id}`,
            effort: inheritedParentEffort(pi),
          },
        }
      : objectPart6996_0;
    const objectPart6996_2 = {
      ...objectPart6996_1,
      forkAvailable: Boolean(ctx.sessionManager.getSessionFile() && stableParentLeaf(ctx)),
    };
    return objectPart6996_2;
  })();

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
    const disallowedField = firstDisallowedLaunchOverride(rawInput);
    if (disallowedField)
      return yield* new InvalidSubagentRequestError({
        code: "launch_override_not_allowed",
        message: disallowedLaunchOverrideMessage(disallowedField),
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
            isCleanupUnconfirmed(error) || isOutcomeUncertain(error)
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
    return (() => {
      const objectPart14019_0 = {};
      const objectPart14019_1 = rawInput.name?.trim()
        ? { ...objectPart14019_0, name: rawInput.name.trim() }
        : objectPart14019_0;
      const objectPart14019_2 = {
        ...objectPart14019_1,
        host: concrete.host,
        runtime: concrete.runtime,
        closeOnReport: concrete.closeOnReport,
        fastMode: concrete.fastMode,
        task,
        profile: definition.id,
        profileGuidance: definition.guidance,
        selection: selected.selection,
        cwd: environment.cwd,
        context: selected.attempt.effectiveContext,
        writeIntent: selected.attempt.writeIntent,
        model: concrete.model,
      };
      const objectPart14019_3 = concrete.runtimeApiKey
        ? { ...objectPart14019_2, runtimeApiKey: concrete.runtimeApiKey }
        : objectPart14019_2;
      const objectPart14019_4 = {
        ...objectPart14019_3,
        effort: concrete.effort,
        effortWasExplicit: concrete.effortWasExplicit,
        activeTools: piToolsForWriteIntent(
          pi.getActiveTools().filter((name) => !ORCHESTRATION_TOOL_DENYLIST.has(name)),
          selected.attempt.writeIntent,
        ),
        projectTrusted: environment.projectTrusted,
        parentSessionId: ctx.sessionManager.getSessionId(),
      };
      const objectPart14019_5 = parentSessionFile
        ? { ...objectPart14019_4, parentSessionFile }
        : objectPart14019_4;
      const objectPart14019_6 = parentLeafId
        ? { ...objectPart14019_5, parentLeafId }
        : objectPart14019_5;
      return objectPart14019_6;
    })() satisfies StartSubagentRequest;
  });
