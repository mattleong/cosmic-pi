import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { isProjectTrusted } from "pi-cosmic-core";
import { ORCHESTRATION_TOOL_DENYLIST, piToolsForWriteIntent } from "../run/coordination.ts";
import { InvalidSubagentRequestError, type SubagentProcessError } from "../run/errors.ts";
import { claudeCliModelConflict, resolvePiModelSelector } from "../run/model-catalog.ts";
import {
  isClaudeModelSelector,
  type StartSubagentRequest,
  type SubagentBackend,
  type SubagentContextMode,
  type SubagentEffort,
  type SubagentExecution,
  type SubagentWriteIntent,
} from "../run/model.ts";
import {
  PROFILE_IDS,
  type SkippedProfileCandidate,
  type SubagentSelectionProvenance,
} from "../profiles/model.ts";
import type { ProfileCandidateAttempt, ProfileResolutionEnvironment } from "../profiles/resolve.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import { ensureClaudeCliReady } from "./claude-preflight.ts";

export interface SubagentProfileStartSpec {
  readonly task: string;
  readonly name?: string | undefined;
  readonly execution?: SubagentExecution | undefined;
  readonly context?: SubagentContextMode | undefined;
  readonly profile?: string | undefined;
  readonly backend: "auto" | SubagentBackend;
  readonly writeIntent: SubagentWriteIntent;
  readonly model?: string | undefined;
  readonly effort?: SubagentEffort | undefined;
}

export interface SubagentStartBoundaries {
  readonly ensureClaudeReady: () => Effect.Effect<void, SubagentProcessError>;
}

export const liveSubagentStartBoundaries: SubagentStartBoundaries = {
  ensureClaudeReady: ensureClaudeCliReady,
};

const stableParentLeaf = (ctx: ExtensionContext): string | undefined => {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (!leaf) return undefined;
  if (leaf.type === "message" && leaf.message.role === "assistant")
    return leaf.parentId ?? undefined;
  return leaf.id;
};

const resolvePiModel = (
  selector: string | undefined,
  ctx: ExtensionContext,
): Effect.Effect<
  { readonly model: string; readonly runtimeApiKey?: string | undefined },
  InvalidSubagentRequestError
> =>
  Effect.gen(function* () {
    const requested = selector?.trim();
    let provider: string;
    let id: string;
    if (requested) {
      const available = ctx.modelRegistry
        .getAvailable()
        .map((model) => ({ provider: model.provider, id: model.id }));
      const resolution = resolvePiModelSelector(requested, available);
      if (resolution.kind === "ambiguous")
        return yield* new InvalidSubagentRequestError({
          code: "pi_model_ambiguous",
          message: `Pi model "${requested}" matches multiple authenticated providers: ${resolution.candidates.join(", ")}. Pass one canonical provider/model value.`,
        });
      if (resolution.kind === "unknown")
        return yield* new InvalidSubagentRequestError({
          code: "pi_model_unknown",
          message: `Unknown or unauthenticated Pi model "${requested}".${resolution.nearMatches.length > 0 ? ` Close authenticated matches: ${resolution.nearMatches.join(", ")}.` : ""} Use subagent_models for launch-ready values.`,
        });
      provider = resolution.provider;
      id = resolution.id;
    } else {
      const inherited = ctx.model;
      if (!inherited)
        return yield* new InvalidSubagentRequestError({
          code: "pi_model_missing",
          message: "No parent model is active; specify model.",
        });
      provider = inherited.provider;
      id = inherited.id;
    }
    const modelId = `${provider}/${id}`;
    const model = ctx.modelRegistry.find(provider, id);
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model))
      return yield* new InvalidSubagentRequestError({
        code: "pi_model_unauthenticated",
        message: `Model is unavailable or unauthenticated: ${modelId}`,
      });
    if (ctx.modelRegistry.getProviderAuthStatus(model.provider).source !== "runtime")
      return { model: `${model.provider}/${model.id}` };
    const auth = yield* Effect.tryPromise({
      try: () => ctx.modelRegistry.getApiKeyAndHeaders(model),
      catch: () =>
        new InvalidSubagentRequestError({
          message: `Unable to resolve runtime authentication for ${modelId}.`,
        }),
    });
    if (!auth.ok || !auth.apiKey)
      return yield* new InvalidSubagentRequestError({
        message: `Runtime authentication is unavailable for ${modelId}.`,
      });
    return { model: `${model.provider}/${model.id}`, runtimeApiKey: auth.apiKey };
  });

interface ResolvedConcreteModel {
  readonly backend: SubagentBackend;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly effortWasExplicit: boolean;
  readonly runtimeApiKey?: string | undefined;
}

export const hostProfileEnvironment = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): ProfileResolutionEnvironment => ({
  availablePiModels: ctx.modelRegistry
    .getAvailable()
    .map((model) => ({ provider: model.provider, id: model.id })),
  ...(ctx.model
    ? {
        parentModel: {
          model: `${ctx.model.provider}/${ctx.model.id}`,
          effort: pi.getThinkingLevel() as SubagentEffort,
        },
      }
    : {}),
  projectTrusted: isProjectTrusted(ctx),
  forkAvailable: Boolean(ctx.sessionManager.getSessionFile() && stableParentLeaf(ctx)),
});

const resolveConcreteModel = (
  backend: SubagentBackend,
  selector: string | undefined,
  effort: SubagentEffort,
  effortWasExplicit: boolean,
  ctx: ExtensionContext,
): Effect.Effect<ResolvedConcreteModel, InvalidSubagentRequestError> =>
  Effect.gen(function* () {
    if (backend === "pi") {
      const resolved = yield* resolvePiModel(selector, ctx);
      return { backend, ...resolved, effort, effortWasExplicit };
    }
    if (!isProjectTrusted(ctx))
      return yield* new InvalidSubagentRequestError({
        code: "claude_untrusted",
        message:
          "Claude CLI subagents require a trusted project because claude -p skips its trust dialog.",
      });
    if (effortWasExplicit && (effort === "off" || effort === "minimal"))
      return yield* new InvalidSubagentRequestError({
        code: "claude_effort_unsupported",
        message: `Claude CLI does not support effort ${effort}; use low through max.`,
      });
    const requested = selector?.trim() || "sonnet";
    const conflict = claudeCliModelConflict(
      requested,
      ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id })),
    );
    if (conflict) return yield* new InvalidSubagentRequestError(conflict);
    if (!isClaudeModelSelector(requested))
      return yield* new InvalidSubagentRequestError({
        code: "claude_model_invalid",
        message:
          'Claude model must be fable, sonnet, opus, haiku, or a full model ID beginning with "claude" (at most 128 characters).',
      });
    return { backend, model: requested, effort, effortWasExplicit };
  });

const dynamicCandidateSkip = (
  attempt: ProfileCandidateAttempt,
  effort: SubagentEffort,
  error: { readonly message: string; readonly _tag: string; readonly code?: string | undefined },
): SkippedProfileCandidate => ({
  ...(attempt.candidateIndex === undefined ? {} : { candidateIndex: attempt.candidateIndex }),
  candidate: `${attempt.backend}/${attempt.model}:${effort}`,
  code: error.code || error._tag,
  reason: error.message,
});

export const resolveProfileStart = (
  pi: ExtensionAPI,
  input: SubagentProfileStartSpec,
  ctx: ExtensionContext,
  boundaries: SubagentStartBoundaries,
): Effect.Effect<StartSubagentRequest, InvalidSubagentRequestError, SubagentProfileService> =>
  Effect.gen(function* () {
    const profiles = yield* SubagentProfileService;
    const task = input.task.trim();
    if (!task)
      return yield* new InvalidSubagentRequestError({
        message: "subagent_start requires every agent to have a task.",
      });
    if (input.backend === "auto" && input.model?.trim())
      return yield* new InvalidSubagentRequestError({
        code: "auto_model_conflict",
        message:
          'backend "auto" cannot combine with model; use the profile route or choose backend "pi"/"claude-cli" for an explicit model override.',
      });

    const requestedProfile = input.profile?.trim();
    const selectedProfile =
      input.backend === "auto"
        ? requestedProfile || profiles.config.defaultProfile
        : requestedProfile;
    const definition = selectedProfile ? profiles.definition(selectedProfile) : undefined;
    if (selectedProfile && !definition)
      return yield* new InvalidSubagentRequestError({
        code: "profile_unknown",
        message: `Unknown subagent profile "${selectedProfile}". Available profiles: ${PROFILE_IDS.join(", ")}.`,
      });
    const context = input.context ?? definition?.defaultContext ?? "fresh";
    const parentSessionFile = ctx.sessionManager.getSessionFile();
    const parentLeafId = stableParentLeaf(ctx);
    if (context === "fork" && (!parentSessionFile || !parentLeafId))
      return yield* new InvalidSubagentRequestError({
        code: "fork_context_unavailable",
        message:
          "Forked context requires a persisted parent session with a stable leaf; oracle does not silently degrade to fresh context.",
      });

    let concrete: ResolvedConcreteModel;
    let selection: SubagentSelectionProvenance;
    let claudeReadiness: Exit.Exit<void, SubagentProcessError> | undefined;
    const ensureClaudeReady = (): Effect.Effect<void, SubagentProcessError> =>
      claudeReadiness ??
      boundaries.ensureClaudeReady().pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            claudeReadiness = exit;
          }),
        ),
        Effect.flatMap((exit) => exit),
      );
    if (input.backend !== "auto") {
      if (input.backend === "claude-cli" && context === "fork")
        return yield* new InvalidSubagentRequestError({
          code: "claude_context_unsupported",
          message: "Claude CLI does not support forked Pi context yet; use context=fresh.",
        });
      const inheritedEffort = pi.getThinkingLevel() as SubagentEffort;
      const selectedEffort = input.effort ?? definition?.defaultEffort ?? inheritedEffort;
      const effort =
        input.effort === undefined &&
        input.backend === "claude-cli" &&
        (selectedEffort === "off" || selectedEffort === "minimal")
          ? "low"
          : selectedEffort;
      concrete = yield* resolveConcreteModel(
        input.backend,
        input.model,
        effort,
        // Profile effort defaults are soft preferences; only the per-call effort is enforced.
        input.effort !== undefined,
        ctx,
      );
      const policy = profiles.policyFor(concrete.backend, concrete.model);
      if (policy === "denied")
        return yield* new InvalidSubagentRequestError({
          code: "model_denied",
          message: `Model ${concrete.backend}/${concrete.model} is denied by Subagents policy and cannot be started.`,
        });
      selection = {
        source: "explicit",
        reason: selectedProfile
          ? `Explicit backend/model routing overrode profile ${selectedProfile}; profile guidance was retained.`
          : "Explicit backend/model selection.",
        skippedCandidates: [],
        ...(policy === "discouraged"
          ? {
              warning: `Model ${concrete.backend}/${concrete.model} is discouraged by policy; explicit selection was honored.`,
            }
          : {}),
      };
    } else {
      const profile = definition?.id;
      if (!profile)
        return yield* new InvalidSubagentRequestError({
          code: "profile_unknown",
          message: "Automatic backend selection requires a valid profile.",
        });
      const plan = profiles.resolve(
        profile,
        hostProfileEnvironment(pi, ctx),
        context,
        input.effort,
      );
      if (plan.kind === "failed")
        return yield* new InvalidSubagentRequestError({ code: plan.code, message: plan.message });
      const tryAttempt = (
        index: number,
        skippedCandidates: ReadonlyArray<SkippedProfileCandidate>,
      ): Effect.Effect<
        {
          readonly concrete: ResolvedConcreteModel;
          readonly selection: SubagentSelectionProvenance;
        },
        InvalidSubagentRequestError
      > => {
        const attempt = plan.attempts[index];
        if (!attempt) {
          const exhausted = [...skippedCandidates, ...plan.trailingSkippedCandidates];
          return Effect.fail(
            new InvalidSubagentRequestError({
              code: "profile_no_eligible_model",
              message: `Profile ${profile} has no eligible model after pre-start checks.${exhausted.length > 0 ? ` ${exhausted.map((candidate) => candidate.reason).join(" ")}` : ""}`,
            }),
          );
        }
        const precedingSkips = [...skippedCandidates, ...(attempt.skippedBefore ?? [])];
        const effort = input.effort ?? attempt.effort;
        const effortWasExplicit = input.effort !== undefined || attempt.effortWasExplicit;
        const readiness = attempt.backend === "claude-cli" ? ensureClaudeReady() : Effect.void;
        return readiness.pipe(
          Effect.andThen(
            resolveConcreteModel(attempt.backend, attempt.model, effort, effortWasExplicit, ctx),
          ),
          Effect.matchEffect({
            onFailure: (error) =>
              tryAttempt(index + 1, [
                ...precedingSkips,
                dynamicCandidateSkip(attempt, effort, error),
              ]),
            onSuccess: (resolved) =>
              Effect.succeed({
                concrete: resolved,
                selection: {
                  source: attempt.source,
                  ...(attempt.candidateIndex === undefined
                    ? {}
                    : { candidateIndex: attempt.candidateIndex }),
                  reason: attempt.reason,
                  skippedCandidates: precedingSkips,
                },
              }),
          }),
        );
      };
      const selected = yield* tryAttempt(0, []);
      concrete = selected.concrete;
      selection = selected.selection;
    }

    return {
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      backend: concrete.backend,
      task,
      ...(definition ? { profile: definition.id, profileGuidance: definition.guidance } : {}),
      selection,
      cwd: ctx.cwd,
      execution: input.execution ?? "background",
      context,
      writeIntent: input.writeIntent,
      model: concrete.model,
      ...(concrete.runtimeApiKey ? { runtimeApiKey: concrete.runtimeApiKey } : {}),
      effort: concrete.effort,
      effortWasExplicit: concrete.effortWasExplicit,
      activeTools:
        concrete.backend === "pi"
          ? piToolsForWriteIntent(
              pi.getActiveTools().filter((name) => !ORCHESTRATION_TOOL_DENYLIST.has(name)),
              input.writeIntent,
            )
          : [],
      projectTrusted: isProjectTrusted(ctx),
      parentSessionId: ctx.sessionManager.getSessionId(),
      ...(parentSessionFile ? { parentSessionFile } : {}),
      ...(parentLeafId ? { parentLeafId } : {}),
    } satisfies StartSubagentRequest;
  });
