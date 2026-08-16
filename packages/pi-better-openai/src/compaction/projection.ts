import type { Api, Model } from "@earendil-works/pi-ai";
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

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const JsonObjectArraySchema = Schema.Array(Schema.Record(Schema.String, Schema.Json));

export interface ActiveOpenAICompactionCheckpoint {
  readonly checkpoint: OpenAICompactionCheckpoint;
  readonly entryIndex: number;
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
): ActiveOpenAICompactionCheckpoint | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (!entry || entry.type !== "compaction") continue;
    const details = decodeOpenAICompactionDetails(entry.details);
    if (!details) return undefined;
    const checkpoint = details.checkpoint;
    if (
      checkpoint.provider === model.provider &&
      checkpoint.api === model.api &&
      checkpoint.model === model.id
    )
      return { checkpoint, entryIndex: index };
    return undefined;
  }
  return undefined;
}

/** Project persisted Pi entries with the same OpenAI Responses converter used by pi-ai. */
export function projectOpenAIResponseInput(
  model: Model<"openai-responses">,
  entries: readonly SessionEntry[],
): readonly OpenAICompactionJsonObject[] | undefined {
  const messages = convertToLlm(
    entries.flatMap((entry) =>
      entry.type === "compaction" && decodeOpenAICompactionDetails(entry.details)
        ? []
        : sessionEntryToContextMessages(entry),
    ),
  );
  const converted = convertResponsesMessages(model, { messages }, OPENAI_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false,
  });
  return Option.getOrUndefined(Schema.decodeUnknownOption(JsonObjectArraySchema)(converted));
}

/** Apply an extension checkpoint to the already-built provider payload. */
export function injectOpenAICompactionCheckpoint<PayloadInput>(
  payload: PayloadInput,
  checkpoint: OpenAICompactionCheckpoint,
) {
  if (!Predicate.isObject(payload) || !Array.isArray(payload.input)) return undefined;
  const input = payload.input;
  let instructionCount = 0;
  while (instructionCount < input.length) {
    const item = input[instructionCount];
    if (!Predicate.isObject(item) || (item.role !== "system" && item.role !== "developer")) break;
    instructionCount++;
  }
  const providerInput = input.slice(instructionCount);
  if (providerInput.length < checkpoint.rawInputCount) return undefined;
  return {
    ...payload,
    input: [
      ...input.slice(0, instructionCount),
      ...checkpoint.output,
      ...providerInput.slice(checkpoint.rawInputCount),
    ],
  };
}
