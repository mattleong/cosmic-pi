import {
  getDeclaredTools,
  normalizeContext,
  resolveTranscript,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { createGrammarToolInputProperties } from "#pi-ai-constrained-sampling";
// Keep Pi's jiti root alias from treating this deep export as a child of compat.js.
import { convertResponsesMessages } from "#pi-ai-openai-responses-shared";
import {
  convertToLlm,
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  decodeOpenAICompactionDetails,
  type OpenAICompactionCheckpoint,
  type OpenAICompactionJsonObject,
} from "./protocol.ts";

import { hasExactPrefix } from "./context.ts";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const JsonObjectArraySchema = Schema.Array(Schema.Record(Schema.String, Schema.Json));
const NativeJsonSchema = Schema.fromJsonString(Schema.Unknown);
const InputJsonSchema = Schema.fromJsonString(JsonObjectArraySchema);

function leadingInstructionCount(input: readonly unknown[]): number {
  let count = 0;
  while (count < input.length) {
    const item = input[count];
    if (!Predicate.isObject(item) || (item.role !== "system" && item.role !== "developer")) break;
    count++;
  }
  return count;
}

export function isEligibleOpenAICompactionModel(
  model: Model<Api> | null | undefined,
): model is Model<"openai-responses"> {
  return model?.provider === "openai" && model.api === "openai-responses";
}

/** Find a matching checkpoint on the active branch. A later Pi compaction supersedes it. */
export function findActiveOpenAICompactionCheckpoint(
  branch: readonly SessionEntry[],
  model: Model<Api>,
): OpenAICompactionCheckpoint | undefined {
  const latest = branch.findLast((entry) => entry?.type === "compaction");
  const checkpoint =
    latest?.type === "compaction"
      ? decodeOpenAICompactionDetails(latest.details)?.checkpoint
      : undefined;
  return checkpoint &&
    checkpoint.provider === model.provider &&
    checkpoint.api === model.api &&
    checkpoint.model === model.id
    ? checkpoint
    : undefined;
}

/** Project persisted Pi entries with the same OpenAI Responses converter used by pi-ai. */
export function projectOpenAIResponseInput(
  model: Model<"openai-responses">,
  entries: readonly SessionEntry[],
): readonly OpenAICompactionJsonObject[] | undefined {
  const messages = convertToLlm(
    entries.flatMap((entry) =>
      entry.type === "compaction" && decodeOpenAICompactionDetails(entry.details)
        ? entry.systemMessage
          ? [entry.systemMessage]
          : []
        : sessionEntryToContextMessages(entry),
    ),
  );
  const context = resolveTranscript(
    normalizeContext({ messages }),
    model.compat?.supportsMidConvoSystemMessages ?? false,
  );
  const converted = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
    grammarToolInputProperties: createGrammarToolInputProperties(
      getDeclaredTools(context.messages),
      model.compat?.supportsOpenAIGrammarTools ?? false,
    ),
    supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
    supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
    supportsToolSearch: model.compat?.supportsToolSearch ?? false,
    toolOptions: {
      supportsStrictMode: model.compat?.supportsStrictMode ?? false,
      supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
    },
  });
  // The native SDK serializes optional undefined fields away before sending.
  const json = Schema.encodeSync(NativeJsonSchema)(converted);
  const input = Option.getOrUndefined(Schema.decodeOption(InputJsonSchema)(json));
  return input?.slice(leadingInstructionCount(input));
}

/** Apply an extension checkpoint to the already-built provider payload. */
export function injectOpenAICompactionCheckpoint<PayloadInput>(
  payload: PayloadInput,
  checkpoint: OpenAICompactionCheckpoint,
  coveredInput: readonly OpenAICompactionJsonObject[],
) {
  if (!Predicate.isObject(payload) || !Array.isArray(payload.input)) return undefined;
  const input = payload.input;
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
