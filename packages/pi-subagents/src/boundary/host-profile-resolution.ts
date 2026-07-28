import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { ORCHESTRATION_TOOL_DENYLIST, piToolsForWriteIntent } from "../run/coordination.ts";
import { InvalidSubagentRequestError, type SubagentProcessError } from "../run/errors.ts";
import {
  claudeCliModelConflict,
  parseExplicitSubagentModelSelector,
  resolvePiModelSelector,
} from "../run/model-catalog.ts";
import {
  decodeSubagentEffort,
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
  /** Canonical one-run selector: pi/provider/model-id or claude-cli/alias-or-full-id. */
  readonly model?: string | undefined;
  readonly writeIntent?: SubagentWriteIntent | undefined;
  readonly effort?: SubagentEffort | undefined;
}

export interface SubagentSessionEnvironment {
  readonly cwd: string;
  readonly projectTrusted: boolean;
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

const deniedModelError = (backend: SubagentBackend, model: string) =>
  new InvalidSubagentRequestError({
    code: "model_denied",
    message: `Model ${backend}/${model} is denied by Subagents policy and cannot be started.`,
  });

type LaunchRouting =
  | { readonly backend: "auto"; readonly model?: undefined }
  | { readonly backend: SubagentBackend; readonly model: string };

const launchRouting = (
  selector: string | undefined,
): Effect.Effect<LaunchRouting, InvalidSubagentRequestError> => {
  const value = selector?.trim();
  if (!value) return Effect.succeed({ backend: "auto" });
  const explicit = parseExplicitSubagentModelSelector(value);
  if (explicit) return Effect.succeed(explicit);
  return Effect.fail(
    new InvalidSubagentRequestError({
      code: "model_selector_invalid",
      message:
        'Explicit model must use "pi/provider/model-id" or "claude-cli/alias-or-full-id". Copy a selector from subagent_models when available; full Claude model IDs are also accepted. Omit model for automatic profile routing.',
    }),
  );
};

const resolvePiModel = (
  selector: string | undefined,
  effort: SubagentEffort,
  effortWasExplicit: boolean,
  ctx: ExtensionContext,
  isPiModelDenied: (model: string) => boolean,
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
    // Deterministic hard-deny on the resolved canonical model before any registry auth lookup or
    // runtime API-key resolution; the start path rechecks the deny as defense in depth.
    if (isPiModelDenied(modelId)) return yield* deniedModelError("pi", modelId);
    const model = ctx.modelRegistry.find(provider, id);
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

/**
 * Host thinking levels arrive untyped. Unknown or malformed values clamp to the shared "high"
 * inheritance default so an unrecognized level is never forwarded to a Pi or Claude child.
 */
const inheritedParentEffort = (pi: ExtensionAPI): SubagentEffort =>
  decodeSubagentEffort(pi.getThinkingLevel()) ?? "high";

export const hostProfileEnvironment = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  projectTrusted: boolean,
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
  projectTrusted,
  forkAvailable: Boolean(ctx.sessionManager.getSessionFile() && stableParentLeaf(ctx)),
});

const resolveConcreteModel = (
  backend: SubagentBackend,
  selector: string | undefined,
  effort: SubagentEffort,
  effortWasExplicit: boolean,
  projectTrusted: boolean,
  ctx: ExtensionContext,
  isPiModelDenied: (model: string) => boolean,
): Effect.Effect<ResolvedConcreteModel, InvalidSubagentRequestError> =>
  Effect.gen(function* () {
    if (backend === "pi") {
      const resolved = yield* resolvePiModel(
        selector,
        effort,
        effortWasExplicit,
        ctx,
        isPiModelDenied,
      );
      return { backend, ...resolved, effort, effortWasExplicit };
    }
    if (!projectTrusted)
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
  rawInput: SubagentProfileStartSpec,
  ctx: ExtensionContext,
  environment: SubagentSessionEnvironment,
  boundaries: SubagentStartBoundaries,
): Effect.Effect<StartSubagentRequest, InvalidSubagentRequestError, SubagentProfileService> =>
  Effect.gen(function* () {
    const profiles = yield* SubagentProfileService;
    const task = rawInput.task.trim();
    if (!task)
      return yield* new InvalidSubagentRequestError({
        message: "subagent_start requires every agent to have a task.",
      });

    const routing = yield* launchRouting(rawInput.model);
    const requestedProfile = rawInput.profile?.trim();
    const selectedProfile = requestedProfile || profiles.config.defaultProfile;
    const definition = profiles.definition(selectedProfile);
    if (!definition)
      return yield* new InvalidSubagentRequestError({
        code: "profile_unknown",
        message: `Unknown subagent profile "${selectedProfile}". Available profiles: ${PROFILE_IDS.join(", ")}.`,
      });
    const input = {
      ...rawInput,
      ...routing,
      profile: definition.id,
      writeIntent: rawInput.writeIntent ?? definition.defaultWriteIntent,
    };
    const context = input.context ?? definition.defaultContext;
    const projectTrusted = environment.projectTrusted;
    // This backend incompatibility is independent of parent branch state and must win even when
    // that state is ephemeral or malformed. It also precedes every Claude preflight.
    if (input.backend === "claude-cli" && context === "fork")
      return yield* new InvalidSubagentRequestError({
        code: "claude_context_unsupported",
        message: "Claude CLI does not support forked Pi context yet; use context=fresh.",
      });
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
    const isPiModelDenied = (model: string): boolean =>
      profiles.policyFor("pi", model) === "denied";
    if (input.backend !== "auto") {
      // Hard denies are enforced on the deterministic raw selector before registry auth lookup,
      // runtime API-key resolution, or Claude preflight; the resolved canonical model is rechecked
      // below as defense in depth.
      const rawSelector = input.model;
      if (profiles.policyFor(input.backend, rawSelector) === "denied")
        return yield* deniedModelError(input.backend, rawSelector);
      const inheritedEffort = inheritedParentEffort(pi);
      const selectedEffort = input.effort ?? definition.defaultEffort ?? inheritedEffort;
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
        projectTrusted,
        ctx,
        isPiModelDenied,
      );
      const policy = profiles.policyFor(concrete.backend, concrete.model);
      if (policy === "denied") return yield* deniedModelError(concrete.backend, concrete.model);
      if (concrete.backend === "claude-cli")
        yield* ensureClaudeReady().pipe(
          Effect.mapError(
            (error) =>
              new InvalidSubagentRequestError({
                code: error.code ?? error._tag,
                message: error.message,
              }),
          ),
        );
      selection = {
        source: "explicit",
        reason: `Explicit model selection overrode profile ${selectedProfile} routing; profile guidance and defaults were retained.`,
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
        hostProfileEnvironment(pi, ctx, projectTrusted),
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
        const concreteAttempt = resolveConcreteModel(
          attempt.backend,
          attempt.model,
          effort,
          effortWasExplicit,
          projectTrusted,
          ctx,
          isPiModelDenied,
        );
        // Pure backend/model/effort checks must reject before an executable/auth probe is run.
        return concreteAttempt.pipe(
          Effect.flatMap((resolved) =>
            attempt.backend === "claude-cli"
              ? ensureClaudeReady().pipe(Effect.as(resolved))
              : Effect.succeed(resolved),
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
      cwd: environment.cwd,
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
      projectTrusted,
      parentSessionId: ctx.sessionManager.getSessionId(),
      ...(parentSessionFile ? { parentSessionFile } : {}),
      ...(parentLeafId ? { parentLeafId } : {}),
    } satisfies StartSubagentRequest;
  });
