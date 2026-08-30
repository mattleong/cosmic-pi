import * as Schema from "effect/Schema";

export const AdvisorRawFieldSchemas = {
  enabled: Schema.Boolean,
  provider: Schema.String,
  model: Schema.String,
  setupDismissed: Schema.Boolean,
} as const;

export type AdvisorConfig = {
  [Key in keyof typeof AdvisorRawFieldSchemas]?:
    | Schema.Schema.Type<(typeof AdvisorRawFieldSchemas)[Key]>
    | undefined;
};
export type AdvisorConfigPatch = Partial<AdvisorConfig>;

export const ResolvedAdvisorConfigSchema = Schema.Struct({
  configPath: Schema.String,
  enabled: Schema.Boolean,
  provider: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  model: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  setupDismissed: Schema.Boolean,
  configured: Schema.Boolean,
});
export type ResolvedAdvisorConfig = typeof ResolvedAdvisorConfigSchema.Type;

export class AdvisorConfigError extends Schema.TaggedError<AdvisorConfigError>()(
  "AdvisorConfigError",
  { operation: Schema.String, path: Schema.String, message: Schema.String },
) {}

export const DEFAULT_ADVISOR_CONFIG = {
  enabled: false,
  setupDismissed: false,
} as const satisfies Required<Pick<AdvisorConfig, "enabled" | "setupDismissed">>;
