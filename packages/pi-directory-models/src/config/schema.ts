import * as Schema from "effect/Schema";

export const PREFERENCE_VERSION = 1 as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

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

export function makeDirectoryModelPreference(
  cwd: string,
  provider: string,
  model: string,
  thinkingLevel: ThinkingLevel,
): DirectoryModelPreference {
  return { version: PREFERENCE_VERSION, cwd, provider, model, thinkingLevel };
}
