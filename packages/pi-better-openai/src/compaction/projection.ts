import {
  getDeclaredTools,
  normalizeContext,
  PI_AI_VERSION,
  resolveTranscript,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { createGrammarToolInputProperties } from "#pi-ai-constrained-sampling";
import { convertResponsesMessages } from "#pi-ai-openai-responses-shared";
import { PI_AI_VERSION as PROJECTION_PI_AI_VERSION } from "#pi-ai-version";
import {
  convertToLlm,
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined } from "pi-cosmic-core";
import {
  decodeOpenAICompactionDetails,
  JsonObjectSchema,
  type OpenAICompactionCheckpoint,
  type OpenAICompactionJsonObject,
} from "./protocol.ts";
import {
  encodeJson,
  hasExactJsonPrefix,
  latestOwnedCheckpoint,
  type reconstructOpenAIContext,
} from "./context.ts";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const InputJsonSchema = Schema.fromJsonString(Schema.Array(JsonObjectSchema));
// Any effort enables pi-ai's per-reply items, which carry each reply's recorded level. Only the
// trailing item uses this value, and projection drops it because it follows the uncovered tail.
const COVERED_CONFIGURATION_UPDATE_EFFORT = "medium";

function leadingInstructionCount(input: readonly unknown[]): number {
  const end = Option.getOrElse(
    Arr.findFirstIndex(
      input,
      (item) => !Predicate.isObject(item) || (item.role !== "system" && item.role !== "developer"),
    ),
    () => -1,
  );
  return end < 0 ? input.length : end;
}

/** The pi-ai versions behind Pi's provider requests and behind this projection. */
export interface PiAiVersions {
  readonly host: string;
  readonly projection: string;
}

// Pi's extension loader aliases only pi-ai's root, `compat`, `models`, `oauth`, and `providers/all`
// entrypoints, so the `#pi-ai-*` imports of its public `api/*` and `utils/*` subpaths load this
// package's copy while the root import resolves to Pi's. Their output matches Pi's provider input
// only when both copies are the same version.
export const piAiVersions: PiAiVersions = {
  host: PI_AI_VERSION,
  projection: PROJECTION_PI_AI_VERSION,
};

export const projectionMatchesHost = (versions: PiAiVersions): boolean =>
  versions.host === versions.projection;

const isConfigurationUpdate = Schema.is(
  Schema.Struct({ type: Schema.Literal("configuration_update") }),
);

export interface CoveredProjectionOptions {
  /** Pi's provider sent thinking levels as `configuration_update` items (`supportsMidConvoEffort`). */
  readonly configurationUpdates?: boolean;
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

const decodeInputJson = decodeUnknownOrUndefined(InputJsonSchema);

export function projectOpenAIResponseInput(
  model: Model<"openai-responses">,
  entries: readonly SessionEntry[],
  options: CoveredProjectionOptions = {},
): readonly OpenAICompactionJsonObject[] | undefined {
  const flags = compatFlags(model);
  const messages = convertToLlm(Arr.flatMap(entries, projectedEntryMessages));
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
    ...(options.configurationUpdates && {
      configurationUpdateEffort: COVERED_CONFIGURATION_UPDATE_EFFORT,
    }),
  });
  const input = decodeInputJson(encodeJson(converted));
  const end =
    options.configurationUpdates && isConfigurationUpdate(input?.at(-1)) ? -1 : input?.length;
  return input?.slice(leadingInstructionCount(input), end);
}

type CoveredContext = Pick<
  NonNullable<ReturnType<typeof reconstructOpenAIContext>>,
  "checkpoint" | "coveredEntries" | "coveredOmittedEntryIds"
>;

/**
 * Remembers the latest covered projection as each item's `JSON.stringify` text. Covered entries
 * are fixed for a checkpoint and omission set; a covered context edit stops injection first.
 */
export function coveredInputCache() {
  const latest = MutableRef.make<
    { readonly key: string; readonly items: readonly string[] | undefined } | undefined
  >(undefined);
  return (
    model: Model<"openai-responses">,
    restored: CoveredContext,
    options: CoveredProjectionOptions,
  ): readonly string[] | undefined => {
    const key = JSON.stringify([
      restored.checkpoint.id,
      model,
      options.configurationUpdates ?? false,
      restored.coveredOmittedEntryIds,
    ]);
    const cached = MutableRef.get(latest);
    if (cached?.key === key) return cached.items;
    const input = projectOpenAIResponseInput(model, restored.coveredEntries, options);
    const items = input && Arr.map(input, (item) => JSON.stringify(item));
    MutableRef.set(latest, { key, items });
    return items;
  };
}

export function injectOpenAICompactionCheckpoint<PayloadInput>(
  payload: PayloadInput,
  checkpoint: OpenAICompactionCheckpoint,
  projectCovered: (options: CoveredProjectionOptions) => readonly string[] | undefined,
) {
  if (!Predicate.isObject(payload) || !Arr.isArray(payload.input)) return undefined;
  const input: readonly unknown[] = payload.input;
  const coveredInput = projectCovered({
    configurationUpdates: Arr.some(input, isConfigurationUpdate),
  });
  const instructionCount = leadingInstructionCount(input);
  const providerInput = input.slice(instructionCount);
  if (!coveredInput || !hasExactJsonPrefix(providerInput, coveredInput)) return undefined;
  return {
    ...payload,
    input: [
      ...input.slice(0, instructionCount),
      ...checkpoint.output,
      ...providerInput.slice(coveredInput.length),
    ],
  };
}
