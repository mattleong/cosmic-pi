import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { decodeUnknownOrUndefined, type JsonObject } from "pi-cosmic-core";

const PREFERENCE_VERSION = 1 as const;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const ThinkingLevelSchema = Schema.Literals(THINKING_LEVELS);
export type ThinkingLevel = typeof ThinkingLevelSchema.Type;

export const DirectoryModelPreferenceSchema = Schema.Struct({
  version: Schema.Literal(PREFERENCE_VERSION),
  cwd: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  thinkingLevel: ThinkingLevelSchema,
});

export type DirectoryModelPreference = typeof DirectoryModelPreferenceSchema.Type;

/** The fields a saved preference cannot be applied without; the rest decode independently. */
const SavedPreferenceEssentialsSchema = DirectoryModelPreferenceSchema.mapFields(
  Struct.omit(["thinkingLevel"]),
);
const decodeSavedThinkingLevel = decodeUnknownOrUndefined(ThinkingLevelSchema);

/** A saved preference whose thinking level, when absent or invalid, leaves Pi's level alone. */
export interface SavedDirectoryModelPreference extends Omit<
  DirectoryModelPreference,
  "thinkingLevel"
> {
  readonly thinkingLevel: ThinkingLevel | undefined;
  readonly invalidThinkingLevel: boolean;
}

/** Fails only when an essential field is unusable; a bad thinking level is reported instead. */
export const decodeSavedPreference = Effect.fn("DirectoryModelPreference.decodeSaved")(function* (
  document: JsonObject,
) {
  const essentials = yield* Schema.decodeUnknownEffect(SavedPreferenceEssentialsSchema)(document);
  const saved = document["thinkingLevel"];
  const thinkingLevel = decodeSavedThinkingLevel(saved);
  return {
    ...essentials,
    thinkingLevel,
    invalidThinkingLevel: saved !== undefined && saved !== null && thinkingLevel === undefined,
  } satisfies SavedDirectoryModelPreference;
});

export function directoryModelPreference(
  cwd: string,
  provider: string,
  model: string,
  thinkingLevel: ThinkingLevel,
): DirectoryModelPreference {
  return { version: PREFERENCE_VERSION, cwd, provider, model, thinkingLevel };
}
