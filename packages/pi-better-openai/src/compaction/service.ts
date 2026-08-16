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
import * as Schema from "effect/Schema";
import { isFastActive, type FastSnapshot } from "../fast/controller.ts";
import { FAST_SERVICE_TIER } from "../fast/models.ts";
import type { OpenAIProjection } from "../usage/index.ts";
import {
  OpenAICompactionClient,
  type OpenAICompactRequest,
  type OpenAICompactionBoundaryError,
} from "../boundary/openai-compaction.ts";
import {
  findActiveOpenAICompactionCheckpoint,
  injectOpenAICompactionCheckpoint,
  isEligibleOpenAICompactionModel,
  projectOpenAIResponseInput,
} from "./projection.ts";
import {
  decodeOpenAICompactionDetails,
  OPENAI_COMPACTION_DETAILS_TYPE,
  OPENAI_COMPACTION_SUMMARY,
  type OpenAICompactionCheckpoint,
} from "./protocol.ts";

export class OpenAICompactionError extends Schema.TaggedError<OpenAICompactionError>()(
  "OpenAICompactionError",
  {
    operation: Schema.Literals(["context", "projection"]),
    message: Schema.String,
  },
) {}

const compactionError = (operation: OpenAICompactionError["operation"], message: string) =>
  new OpenAICompactionError({ operation, message });

export interface OpenAICompactionServiceContract {
  readonly compact: (
    event: SessionBeforeCompactEvent,
  ) => Effect.Effect<
    CompactionResult | undefined,
    OpenAICompactionError | OpenAICompactionBoundaryError
  >;
  readonly filterContext: (
    messages: ContextEvent["messages"],
  ) => Effect.Effect<ContextEvent["messages"] | undefined, OpenAICompactionError>;
  readonly inject: <Payload>(
    payload: Payload,
  ) => Effect.Effect<
    ReturnType<typeof injectOpenAICompactionCheckpoint<Payload>>,
    OpenAICompactionError
  >;
}

export class OpenAICompactionService extends Context.Service<
  OpenAICompactionService,
  OpenAICompactionServiceContract
>()("pi-better-openai/compaction/service/OpenAICompactionService") {
  static layer(options: {
    readonly context: MutableRef.MutableRef<ExtensionContext>;
    readonly projection: MutableRef.MutableRef<OpenAIProjection>;
    readonly fastProjection: MutableRef.MutableRef<FastSnapshot>;
  }) {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const client = yield* OpenAICompactionClient;
        const readContext = Effect.fn("OpenAICompaction.readContext")(function* () {
          return yield* Effect.try({
            try: () => {
              const ctx = MutableRef.get(options.context);
              return {
                model: ctx.model,
                branch: ctx.sessionManager.getBranch(),
                contextEntries: ctx.sessionManager.buildContextEntries(),
                systemPrompt: ctx.getSystemPrompt(),
                fastActive: isFastActive(ctx, MutableRef.get(options.fastProjection)),
              };
            },
            catch: () =>
              compactionError("context", "Unable to read the current Pi session context."),
          });
        });
        const compact: OpenAICompactionServiceContract["compact"] = Effect.fn(
          "OpenAICompaction.compact",
        )(function* (event) {
          const config = MutableRef.get(options.projection).config;
          if (!config?.compaction.enabled) return undefined;
          const current = yield* readContext();
          if (!isEligibleOpenAICompactionModel(current.model)) return undefined;
          const firstKeptEntryId = event.branchEntries[0]?.id;
          if (!firstKeptEntryId) return undefined;
          const model = current.model;
          const rawInput = yield* Effect.try({
            try: () => projectOpenAIResponseInput(model, current.contextEntries),
            catch: () =>
              compactionError("projection", "Unable to project the OpenAI compaction input."),
          });
          if (!rawInput)
            return yield* compactionError(
              "projection",
              "Unable to project the OpenAI compaction input.",
            );
          const active = findActiveOpenAICompactionCheckpoint(current.branch, model);
          const input =
            active && rawInput.length >= active.checkpoint.rawInputCount
              ? [...active.checkpoint.output, ...rawInput.slice(active.checkpoint.rawInputCount)]
              : rawInput;
          const customInstructions = event.customInstructions?.trim();
          const instructions = [
            current.systemPrompt.trim(),
            customInstructions ? `Compaction guidance:\n${customInstructions}` : undefined,
          ]
            .filter((value): value is string => Boolean(value))
            .join("\n\n");
          const result = yield* client.compact(
            (() => {
              const objectPart4544_0 = { model, input };
              const objectPart4544_1 = instructions
                ? { ...objectPart4544_0, instructions }
                : objectPart4544_0;
              const objectPart4544_2: OpenAICompactRequest = current.fastActive
                ? { ...objectPart4544_1, serviceTier: FAST_SERVICE_TIER }
                : objectPart4544_1;
              return objectPart4544_2;
            })(),
          );
          const now = yield* Clock.currentTimeMillis;
          const checkpoint: OpenAICompactionCheckpoint = {
            version: 1,
            provider: "openai",
            api: "openai-responses",
            model: model.id,
            output: result.output,
            rawInputCount: rawInput.length,
            createdAt: now,
            tokensBefore: Math.max(0, Math.floor(event.preparation.tokensBefore)),
            usage: result.usage,
          };
          return {
            summary: OPENAI_COMPACTION_SUMMARY,
            firstKeptEntryId,
            tokensBefore: checkpoint.tokensBefore,
            details: { type: OPENAI_COMPACTION_DETAILS_TYPE, checkpoint },
          } satisfies CompactionResult;
        });
        const filterContext: OpenAICompactionServiceContract["filterContext"] = Effect.fn(
          "OpenAICompaction.filterContext",
        )(function* (messages) {
          const config = MutableRef.get(options.projection).config;
          if (!config?.compaction.enabled) return undefined;
          const branch = yield* Effect.try({
            try: () => MutableRef.get(options.context).sessionManager.getBranch(),
            catch: () =>
              compactionError("context", "Unable to read the current Pi session branch."),
          });
          let latestCompaction: (typeof branch)[number] | undefined;
          for (let index = branch.length - 1; index >= 0; index--) {
            const entry = branch[index];
            if (entry?.type === "compaction") {
              latestCompaction = entry;
              break;
            }
          }
          if (
            !latestCompaction ||
            latestCompaction.type !== "compaction" ||
            !decodeOpenAICompactionDetails(latestCompaction.details)
          )
            return undefined;
          const summaryIndex = messages.findIndex(
            (message) =>
              message.role === "compactionSummary" && message.summary === OPENAI_COMPACTION_SUMMARY,
          );
          return summaryIndex < 0
            ? undefined
            : messages.filter((_message, index) => index !== summaryIndex);
        });
        const inject: OpenAICompactionServiceContract["inject"] = Effect.fn(
          "OpenAICompaction.inject",
        )(function* (payload) {
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
          return active ? injectOpenAICompactionCheckpoint(payload, active.checkpoint) : undefined;
        });
        return OpenAICompactionService.of({ compact, filterContext, inject });
      }),
    );
  }
}
