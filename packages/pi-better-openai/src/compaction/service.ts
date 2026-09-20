import { calculateCost, getCurrentSystemPrompt, type Usage } from "@earendil-works/pi-ai";
import type {
  CompactionResult,
  ContextEvent,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { isFastActive, type FastSnapshot } from "../fast/controller.ts";
import { FAST_SERVICE_TIER } from "../fast/models.ts";
import type { OpenAIProjection } from "../usage/projection.ts";
import {
  OpenAICompactionClient,
  type OpenAICompactRequest,
} from "../boundary/openai-compaction.ts";
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
} from "./protocol.ts";

import { compactWithPi } from "../boundary/host-compaction.ts";
import {
  hasExactPrefix,
  latestOwnedCompaction,
  reconstructOpenAIContext,
  repairOpenAIContext,
  retryOmissions,
} from "./context.ts";
import { prepareOpenAIFallback } from "./fallback.ts";

export class OpenAICompactionError extends Schema.TaggedError<OpenAICompactionError>()(
  "OpenAICompactionError",
  {
    operation: Schema.Literals(["context", "projection"]),
    message: Schema.String,
  },
) {}

const compactionError = (operation: OpenAICompactionError["operation"], message: string) =>
  new OpenAICompactionError({ operation, message });

interface OpenAICompactionServiceOptions {
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly projection: MutableRef.MutableRef<OpenAIProjection>;
  readonly fastProjection: MutableRef.MutableRef<FastSnapshot>;
}

export class OpenAICompactionService extends Context.Service<OpenAICompactionService>()(
  "pi-better-openai/compaction/service/OpenAICompactionService",
  {
    make: (options: OpenAICompactionServiceOptions) =>
      Effect.gen(function* () {
        const client = yield* OpenAICompactionClient;
        const observedOmissions = yield* Ref.make<readonly string[]>([]);
        const readContext = Effect.fn("OpenAICompaction.readContext")(function* (
          willRetry: boolean,
        ) {
          const observed = yield* Ref.get(observedOmissions);
          const current = yield* Effect.try({
            try: () => {
              const ctx = MutableRef.get(options.context);
              const branch = ctx.sessionManager.getBranch();
              const omittedEntryIds = retryOmissions(branch, observed, willRetry);
              const restored = reconstructOpenAIContext(branch, omittedEntryIds);
              return {
                omittedEntryIds,
                model: ctx.model,
                branch,
                restored,
                contextEntries:
                  restored?.entries ??
                  ctx.sessionManager
                    .buildContextEntries()
                    .filter((entry) => !omittedEntryIds.includes(entry.id)),
                systemPrompt: restored
                  ? getCurrentSystemPrompt(restored.messages)
                  : ctx.getSystemPrompt(),
                fastActive: isFastActive(ctx, MutableRef.get(options.fastProjection)),
              };
            },
            catch: () =>
              compactionError("context", "Unable to read the current Pi session context."),
          });
          yield* Ref.set(observedOmissions, current.omittedEntryIds);
          return current;
        });
        const compactOpenAI = Effect.fn("OpenAICompaction.compactOpenAI")(function* (
          event: SessionBeforeCompactEvent,
        ) {
          const config = MutableRef.get(options.projection).config;
          if (!config?.compaction.enabled) return undefined;
          const current = yield* readContext(event.willRetry);
          if (!isEligibleOpenAICompactionModel(current.model)) return undefined;
          // Keep only the last branch entry. Pi persists the full branch for navigation;
          // retaining older compactions would replay their system snapshots after the new one.
          const anchor = current.branch.at(-1);
          if (!anchor || anchor.type === "compaction") return undefined;
          const firstKeptEntryId = anchor.id;
          const model = current.model;
          const projected = yield* Effect.try({
            try: () => ({
              input: projectOpenAIResponseInput(model, current.contextEntries),
              covered: projectOpenAIResponseInput(model, current.restored?.coveredEntries ?? []),
              // Native buildContextEntries omits retained system messages. The new
              // compaction's folded system snapshot supplies the leading instructions.
              retained: projectOpenAIResponseInput(
                model,
                anchor.type === "message" && anchor.message.role === "system" ? [] : [anchor],
              ),
            }),
            catch: () =>
              compactionError("projection", "Unable to project the OpenAI compaction input."),
          });
          const rawInput = projected.input;
          if (!rawInput || !projected.retained)
            return yield* compactionError(
              "projection",
              "Unable to project the OpenAI compaction input.",
            );
          const active = findActiveOpenAICompactionCheckpoint(current.branch, model);
          const input =
            active &&
            !current.restored?.coverageChanged &&
            projected.covered &&
            hasExactPrefix(rawInput, projected.covered)
              ? [...active.output, ...rawInput.slice(projected.covered.length)]
              : rawInput;
          const customInstructions = event.customInstructions?.trim();
          const instructions = [
            current.systemPrompt.trim(),
            customInstructions ? `Compaction guidance:\n${customInstructions}` : undefined,
          ]
            .filter((value): value is string => Boolean(value))
            .join("\n\n");
          const request: Types.Mutable<OpenAICompactRequest> = { model, input };
          if (instructions) request.instructions = instructions;
          if (current.fastActive) request.serviceTier = FAST_SERVICE_TIER;
          const result = yield* client.compact(request);
          const cacheRead = Math.min(result.usage.cachedInputTokens ?? 0, result.usage.inputTokens);
          const usage: Usage = {
            input: result.usage.inputTokens - cacheRead,
            output: result.usage.outputTokens,
            cacheRead,
            cacheWrite: 0,
            totalTokens: result.usage.totalTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
          calculateCost(model, usage);
          const now = yield* Clock.currentTimeMillis;
          const checkpoint: OpenAICompactionCheckpoint = {
            version: 1,
            provider: "openai",
            api: "openai-responses",
            model: model.id,
            output: result.output,
            rawInputCount: projected.retained.length,
            omittedEntryIds: current.omittedEntryIds,
            createdAt: now,
            tokensBefore: Math.max(0, Math.floor(event.preparation.tokensBefore)),
            usage: result.usage,
          };
          return {
            summary: OPENAI_COMPACTION_SUMMARY,
            firstKeptEntryId,
            tokensBefore: checkpoint.tokensBefore,
            usage,
            details: { type: OPENAI_COMPACTION_DETAILS_TYPE, checkpoint },
          } satisfies CompactionResult;
        });
        const readBranch = Effect.fn("OpenAICompaction.readBranch")(function* () {
          return yield* Effect.try({
            try: () => MutableRef.get(options.context).sessionManager.getBranch(),
            catch: () =>
              compactionError("context", "Unable to read the current Pi session branch."),
          });
        });
        const filterContext = Effect.fn("OpenAICompaction.filterContext")(function* (
          messages: ContextEvent["messages"],
        ) {
          const branch = yield* readBranch();
          const observed = yield* Ref.get(observedOmissions);
          const repaired = yield* Effect.try({
            try: () => repairOpenAIContext(branch, messages, observed),
            catch: () =>
              compactionError("context", "Unable to restore the complete Pi conversation."),
          });
          yield* Ref.set(
            observedOmissions,
            repaired?.omittedEntryIds ?? retryOmissions(branch, observed),
          );
          return repaired?.messages;
        });
        const inject = Effect.fn("OpenAICompaction.inject")(function* <Payload>(payload: Payload) {
          const config = MutableRef.get(options.projection).config;
          if (!config?.compaction.enabled) return undefined;
          const current = yield* Effect.try({
            try: () => {
              const ctx = MutableRef.get(options.context);
              return { model: ctx.model, branch: ctx.sessionManager.getBranch() };
            },
            catch: () =>
              compactionError("context", "Unable to read the current Pi session branch."),
          });
          if (!isEligibleOpenAICompactionModel(current.model)) return undefined;
          const active = findActiveOpenAICompactionCheckpoint(current.branch, current.model);
          if (!active) return undefined;
          const model = current.model;
          const observed = yield* Ref.get(observedOmissions);
          return yield* Effect.try({
            try: () => {
              const restored = reconstructOpenAIContext(current.branch, observed);
              if (restored?.coverageChanged) return undefined;
              const covered =
                restored && projectOpenAIResponseInput(model, restored.coveredEntries);
              return covered
                ? injectOpenAICompactionCheckpoint(payload, active, covered)
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
          const branch = yield* readBranch();
          if (!latestOwnedCompaction(branch)) return yield* compactOpenAI(event);
          const ctx = MutableRef.get(options.context);
          const fallback = Effect.fn("OpenAICompaction.fallback")(function* () {
            if (event.signal?.aborted)
              return yield* compactionError("context", "Compaction cancelled.");
            const observed = yield* Ref.get(observedOmissions);
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
            return yield* compactWithPi(MutableRef.get(options.context), event, preparation);
          });
          if (!ctx.model || !findActiveOpenAICompactionCheckpoint(branch, ctx.model))
            return yield* fallback();
          const result = yield* compactOpenAI(event).pipe(Effect.catch(() => fallback()));
          return result ?? (yield* fallback());
        });
        const resetRetryOmissions = Effect.fn("OpenAICompaction.resetRetryOmissions")(() =>
          Ref.set(observedOmissions, []),
        );
        return { compact, filterContext, inject, resetRetryOmissions };
      }),
  },
) {
  static layer(options: OpenAICompactionServiceOptions) {
    return Layer.effect(this, this.make(options));
  }
}
