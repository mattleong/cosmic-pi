import {
  calculateCost,
  getCurrentSystemPrompt,
  type Model,
  type RetryPolicy,
  type Usage,
} from "@earendil-works/pi-ai";
import type {
  CompactionResult,
  ContextWithSystemEvent,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { isFastActive, type FastSnapshot } from "../fast/controller.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { FAST_SERVICE_TIER } from "../fast/models.ts";
import { OpenAICompactionClient, type OpenAICompactUsage } from "../boundary/openai-compaction.ts";
import {
  findActiveOpenAICompactionCheckpoint,
  injectOpenAICompactionCheckpoint,
  isEligibleOpenAICompactionModel,
  projectOpenAIResponseInput,
} from "./projection.ts";
import {
  OPENAI_COMPACTION_DETAILS_TYPE,
  OPENAI_COMPACTION_SUMMARY,
  type OpenAICompactionCheckpoint,
  type OpenAICompactionJsonObject,
} from "./protocol.ts";

import { compactWithPi } from "../boundary/host-compaction.ts";
import {
  hasExactPrefix,
  latestOwnedCheckpoint,
  projectContextEntries,
  reconstructOpenAIContext,
  repairOpenAIContext,
  retryOmissions,
} from "./context.ts";
import { prepareOpenAIFallback } from "./fallback.ts";

const compactionInstructions = (systemPrompt: string, guidance: string | undefined) => {
  const customInstructions = guidance?.trim();
  return [
    systemPrompt.trim(),
    customInstructions ? `Compaction guidance:\n${customInstructions}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
};

const checkpointedInput = (
  active: OpenAICompactionCheckpoint | undefined,
  restored: { readonly coverageChanged: boolean } | undefined,
  rawInput: readonly OpenAICompactionJsonObject[],
  covered: readonly OpenAICompactionJsonObject[] | undefined,
) =>
  active && !restored?.coverageChanged && covered && hasExactPrefix(rawInput, covered)
    ? [...active.output, ...rawInput.slice(covered.length)]
    : rawInput;

const compactionUsage = (model: Model<"openai-responses">, reported: OpenAICompactUsage): Usage => {
  const cacheRead = Math.min(reported.cachedInputTokens ?? 0, reported.inputTokens);
  const usage: Usage = {
    input: reported.inputTokens - cacheRead,
    output: reported.outputTokens,
    cacheRead,
    cacheWrite: 0,
    totalTokens: reported.totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
};

export class OpenAICompactionError extends Schema.TaggedError<
  OpenAICompactionError,
  { readonly brand: unique symbol }
>()("OpenAICompactionError", {
  operation: Schema.Literals(["context", "projection"]),
  message: Schema.String,
}) {}

const compactionError = (operation: OpenAICompactionError["operation"], message: string) =>
  new OpenAICompactionError({ operation, message });

interface OpenAICompactionServiceOptions {
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly config: () => ResolvedConfig | undefined;
  readonly fastProjection: MutableRef.MutableRef<FastSnapshot>;
  // False when this package's pi-ai differs from Pi's, whose payloads its checkpoints might never
  // match. Existing checkpoints still repair and inject: injection replaces only a covered prefix
  // that exactly matches Pi's payload.
  readonly createCheckpoints: boolean;
  readonly retryPolicy: () => RetryPolicy | undefined;
}

export class OpenAICompactionService extends Context.Service<OpenAICompactionService>()(
  "pi-better-openai/compaction/service/OpenAICompactionService",
  {
    make: Effect.fn("OpenAICompactionService.make")(function* (
      options: OpenAICompactionServiceOptions,
    ) {
      const client = yield* OpenAICompactionClient;
      const observedOmissions = yield* SynchronizedRef.make<readonly string[]>([]);
      const readContext = Effect.fn("OpenAICompaction.readContext")((willRetry: boolean) =>
        SynchronizedRef.modifyEffect(observedOmissions, (observed) =>
          Effect.try({
            try: () => {
              const ctx = MutableRef.get(options.context);
              const branch = ctx.sessionManager.getBranch();
              const omittedEntryIds = retryOmissions(branch, observed, willRetry);
              const restored = reconstructOpenAIContext(branch, omittedEntryIds);
              const current = {
                omittedEntryIds,
                model: ctx.model,
                branch,
                restored,
                contextEntries:
                  restored?.entries ??
                  projectContextEntries(branch).filter(
                    (entry) => !omittedEntryIds.includes(entry.id),
                  ),
                systemPrompt: restored
                  ? getCurrentSystemPrompt(restored.messages)
                  : ctx.getSystemPrompt(),
                fastActive: isFastActive(ctx, MutableRef.get(options.fastProjection)),
              };
              return [current, omittedEntryIds] as const;
            },
            catch: () =>
              compactionError("context", "Unable to read the current Pi session context."),
          }),
        ),
      );
      const compactOpenAI = Effect.fn("OpenAICompaction.compactOpenAI")(function* (
        event: SessionBeforeCompactEvent,
      ) {
        const config = options.config();
        if (!config?.compaction.enabled || !options.createCheckpoints) return undefined;
        const current = yield* readContext(event.willRetry);
        if (!isEligibleOpenAICompactionModel(current.model)) return undefined;
        const anchor = current.branch.at(-1);
        if (!anchor || anchor.type === "compaction") return undefined;
        const firstKeptEntryId = anchor.id;
        const model = current.model;
        const projected = yield* Effect.try({
          try: () => ({
            input: projectOpenAIResponseInput(model, current.contextEntries),
            covered: projectOpenAIResponseInput(model, current.restored?.coveredEntries ?? []),
          }),
          catch: () =>
            compactionError("projection", "Unable to project the OpenAI compaction input."),
        });
        const rawInput = projected.input;
        if (!rawInput)
          return yield* compactionError(
            "projection",
            "Unable to project the OpenAI compaction input.",
          );
        const instructions = compactionInstructions(current.systemPrompt, event.customInstructions);
        const result = yield* client.compact({
          model,
          input: checkpointedInput(
            findActiveOpenAICompactionCheckpoint(current.branch, model),
            current.restored,
            rawInput,
            projected.covered,
          ),
          ...(instructions && { instructions }),
          ...(current.fastActive && { serviceTier: FAST_SERVICE_TIER }),
        });
        const usage = compactionUsage(model, result.usage);
        const now = yield* Clock.currentTimeMillis;
        const checkpoint: OpenAICompactionCheckpoint = {
          version: 1,
          provider: "openai",
          api: "openai-responses",
          model: model.id,
          output: result.output,
          omittedEntryIds: current.omittedEntryIds,
          createdAt: now,
        };
        return {
          summary: OPENAI_COMPACTION_SUMMARY,
          firstKeptEntryId,
          tokensBefore: Math.max(0, Math.floor(event.preparation.tokensBefore)),
          usage,
          details: { type: OPENAI_COMPACTION_DETAILS_TYPE, checkpoint },
        } satisfies CompactionResult;
      });
      const readBranch = Effect.try({
        try: () => MutableRef.get(options.context).sessionManager.getBranch(),
        catch: () => compactionError("context", "Unable to read the current Pi session branch."),
      });
      const filterContext = Effect.fn("OpenAICompaction.filterContext")(function* (
        messages: ContextWithSystemEvent["messages"],
      ) {
        const branch = yield* readBranch;
        return yield* SynchronizedRef.modifyEffect(observedOmissions, (observed) =>
          Effect.try({
            try: () => {
              const repaired = repairOpenAIContext(branch, messages, observed);
              const omitted = repaired?.omittedEntryIds ?? retryOmissions(branch, observed);
              return [repaired?.messages, omitted] as const;
            },
            catch: () =>
              compactionError("context", "Unable to restore the complete Pi conversation."),
          }),
        );
      });
      const inject = Effect.fn("OpenAICompaction.inject")(function* <Payload>(payload: Payload) {
        const config = options.config();
        if (!config?.compaction.enabled) return undefined;
        const current = yield* Effect.try({
          try: () => {
            const ctx = MutableRef.get(options.context);
            return { model: ctx.model, branch: ctx.sessionManager.getBranch() };
          },
          catch: () => compactionError("context", "Unable to read the current Pi session branch."),
        });
        if (!isEligibleOpenAICompactionModel(current.model)) return undefined;
        const active = findActiveOpenAICompactionCheckpoint(current.branch, current.model);
        if (!active) return undefined;
        const model = current.model;
        const observed = yield* SynchronizedRef.get(observedOmissions);
        return yield* Effect.try({
          try: () => {
            const restored = reconstructOpenAIContext(current.branch, observed);
            if (restored?.coverageChanged) return undefined;
            return restored
              ? injectOpenAICompactionCheckpoint(payload, active, (projection) =>
                  projectOpenAIResponseInput(model, restored.coveredEntries, projection),
                )
              : undefined;
          },
          catch: () =>
            compactionError("projection", "Unable to project the restored Pi conversation."),
        });
      });
      const compact = Effect.fn("OpenAICompaction.compact")(function* (
        event: SessionBeforeCompactEvent,
      ) {
        if (event.signal?.aborted)
          return yield* compactionError("context", "Compaction cancelled.");
        const branch = yield* readBranch;
        if (!latestOwnedCheckpoint(branch)) return yield* compactOpenAI(event);
        const ctx = MutableRef.get(options.context);
        const fallback = Effect.fn("OpenAICompaction.fallback")(function* () {
          if (event.signal?.aborted)
            return yield* compactionError("context", "Compaction cancelled.");
          const observed = yield* SynchronizedRef.get(observedOmissions);
          const preparation = yield* Effect.try({
            try: () =>
              prepareOpenAIFallback(
                branch,
                event.preparation,
                retryOmissions(branch, observed, event.willRetry),
              ),
            catch: () =>
              compactionError("context", "Unable to prepare the restored Pi conversation."),
          });
          if (!preparation)
            return yield* compactionError("context", "No safe compaction boundary is available.");
          return yield* compactWithPi(
            MutableRef.get(options.context),
            event,
            preparation,
            options.retryPolicy(),
          );
        });
        if (
          !isEligibleOpenAICompactionModel(ctx.model) ||
          !findActiveOpenAICompactionCheckpoint(branch, ctx.model)
        )
          return yield* fallback();
        const result = yield* compactOpenAI(event).pipe(Effect.catch(() => fallback()));
        return result ?? (yield* fallback());
      });
      const resetRetryOmissions = Effect.fn("OpenAICompaction.resetRetryOmissions")(() =>
        SynchronizedRef.set(observedOmissions, []),
      );
      return { compact, filterContext, inject, resetRetryOmissions };
    }),
  },
) {
  static layer(options: OpenAICompactionServiceOptions) {
    return Layer.effect(this, this.make(options));
  }
}
