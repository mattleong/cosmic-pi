import {
  getDeclaredTools,
  normalizeContext,
  resolveTranscript,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { createGrammarToolInputProperties } from "#pi-ai-constrained-sampling";
import { convertResponsesMessages } from "#pi-ai-openai-responses-shared";
import {
  convertToLlm,
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined } from "pi-cosmic-core";
import {
  decodeOpenAICompactionDetails,
  JsonObjectSchema,
  type OpenAICompactionCheckpoint,
  type OpenAICompactionJsonObject,
} from "./protocol.ts";
import { encodeJson, hasExactPrefix, latestOwnedCheckpoint } from "./context.ts";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const InputJsonSchema = Schema.fromJsonString(Schema.Array(JsonObjectSchema));

function leadingInstructionCount(input: readonly unknown[]): number {
  const end = input.findIndex(
    (item) => !Predicate.isObject(item) || (item.role !== "system" && item.role !== "developer"),
  );
  return end < 0 ? input.length : end;
}

export function isEligibleOpenAICompactionModel(
  model: Model<Api> | null | undefined,
): model is Model<"openai-responses"> {
  return model?.provider === "openai" && model.api === "openai-responses";
}

export function findActiveOpenAICompactionCheckpoint(
  branch: readonly SessionEntry[],
  model: Model<Api>,
): OpenAICompactionCheckpoint | undefined {
  const checkpoint = latestOwnedCheckpoint(branch)?.checkpoint;
  return checkpoint &&
    checkpoint.provider === model.provider &&
    checkpoint.api === model.api &&
    checkpoint.model === model.id
    ? checkpoint
    : undefined;
}

const projectedEntryMessages = (entry: SessionEntry) => {
  if (entry.type !== "compaction" || !decodeOpenAICompactionDetails(entry.details))
    return sessionEntryToContextMessages(entry);
  return entry.systemMessage ? [entry.systemMessage] : [];
};

const compatFlags = (model: Model<"openai-responses">) => {
  const compat = model.compat;
  return {
    supportsMidConvoSystemMessages: compat?.supportsMidConvoSystemMessages ?? false,
    supportsOpenAIGrammarTools: compat?.supportsOpenAIGrammarTools ?? false,
    supportsAdditionalTools: compat?.supportsAdditionalTools ?? false,
    supportsToolSearch: compat?.supportsToolSearch ?? false,
    supportsStrictMode: compat?.supportsStrictMode ?? false,
  };
};

export function projectOpenAIResponseInput(
  model: Model<"openai-responses">,
  entries: readonly SessionEntry[],
): readonly OpenAICompactionJsonObject[] | undefined {
  const flags = compatFlags(model);
  const messages = convertToLlm(entries.flatMap(projectedEntryMessages));
  const context = resolveTranscript(
    normalizeContext({ messages }),
    flags.supportsMidConvoSystemMessages,
  );
  const converted = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
    grammarToolInputProperties: createGrammarToolInputProperties(
      getDeclaredTools(context.messages),
      flags.supportsOpenAIGrammarTools,
    ),
    supportsMidConvoSystemMessages: flags.supportsMidConvoSystemMessages,
    supportsAdditionalTools: flags.supportsAdditionalTools,
    supportsToolSearch: flags.supportsToolSearch,
    toolOptions: {
      supportsStrictMode: flags.supportsStrictMode,
      supportsOpenAIGrammarTools: flags.supportsOpenAIGrammarTools,
    },
  });
  const input = decodeUnknownOrUndefined(InputJsonSchema, encodeJson(converted));
  return input?.slice(leadingInstructionCount(input));
}

export function injectOpenAICompactionCheckpoint<PayloadInput>(
  payload: PayloadInput,
  checkpoint: OpenAICompactionCheckpoint,
  coveredInput: readonly OpenAICompactionJsonObject[],
) {
  if (!Predicate.isObject(payload) || !Array.isArray(payload.input)) return undefined;
  const input: readonly unknown[] = payload.input;
  const instructionCount = leadingInstructionCount(input);
  const providerInput = input.slice(instructionCount);
  if (!hasExactPrefix(providerInput, coveredInput)) return undefined;
  return {
    ...payload,
    input: [
      ...input.slice(0, instructionCount),
      ...checkpoint.output,
      ...providerInput.slice(coveredInput.length),
    ],
  };
}
