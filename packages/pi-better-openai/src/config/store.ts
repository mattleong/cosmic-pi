import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Number from "effect/Number";
import * as Schema from "effect/Schema";
import {
  decodeTolerantFields,
  makeConfigDocumentErrorFactory,
  makeScopedConfigStore,
  type JsonObject,
  type ScopedConfigMetadata,
} from "pi-cosmic-core";
import {
  CONFIG_BASENAME,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  DEFAULT_USAGE_CONFIG,
  ImageOutputFormatSchema,
  ImageSaveModeSchema,
  type ResolvedConfig,
} from "./schema.ts";

export class OpenAIConfigError extends Schema.TaggedError<OpenAIConfigError>()(
  "OpenAIConfigError",
  { operation: Schema.String, path: Schema.String, message: Schema.String },
) {}

const mapError = makeConfigDocumentErrorFactory(OpenAIConfigError, "Better OpenAI");

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const FiniteNumberSchema = Schema.Number.check(Schema.isFinite());

/** Tolerant field-level wire decode: one malformed field never discards valid siblings. */
function decodeConfig<ValueInput>(value: ValueInput) {
  const root = decodeTolerantFields(
    value,
    {
      persistState: Schema.Boolean,
      active: Schema.Boolean,
      desiredActive: Schema.Boolean,
      usage: UnknownRecordSchema,
      compaction: UnknownRecordSchema,
      image: UnknownRecordSchema,
    },
    { path: "config" },
  ).value;
  const usage = decodeTolerantFields(
    root.usage,
    {
      refreshIntervalMs: FiniteNumberSchema,
      showOnlyOnSubscriptionModels: Schema.Boolean,
      showResetTimes: Schema.Boolean,
    },
    { path: "usage" },
  ).value;
  const compaction = decodeTolerantFields(
    root.compaction,
    { enabled: Schema.Boolean },
    { path: "compaction" },
  ).value;
  const image = decodeTolerantFields(
    root.image,
    {
      enabled: Schema.Boolean,
      defaultModel: Schema.Trim.check(Schema.isNonEmpty()),
      defaultSave: ImageSaveModeSchema,
      outputFormat: ImageOutputFormatSchema,
      timeoutMs: FiniteNumberSchema,
    },
    { path: "image" },
  ).value;
  return {
    ...(root.persistState !== undefined && { persistState: root.persistState }),
    ...(root.active !== undefined && { active: root.active }),
    ...(root.desiredActive !== undefined && { desiredActive: root.desiredActive }),
    ...(Object.keys(usage).length > 0 && { usage }),
    ...(compaction.enabled !== undefined && { compaction }),
    ...(Object.keys(image).length > 0 && { image }),
  };
}

function resolveConfigFiles(
  metadata: ScopedConfigMetadata,
  project: ReturnType<typeof decodeConfig> | undefined,
  global: ReturnType<typeof decodeConfig> | undefined,
): ResolvedConfig {
  const usage = { ...DEFAULT_USAGE_CONFIG, ...global?.usage, ...project?.usage };
  const image = { ...DEFAULT_IMAGE_CONFIG, ...global?.image, ...project?.image };
  const desiredActive =
    project?.desiredActive ??
    project?.active ??
    global?.desiredActive ??
    global?.active ??
    DEFAULT_CONFIG.desiredActive ??
    false;
  return {
    ...metadata,
    persistState:
      project?.persistState ?? global?.persistState ?? DEFAULT_CONFIG.persistState ?? true,
    desiredActive,
    usage: {
      ...usage,
      refreshIntervalMs: Number.clamp(usage.refreshIntervalMs, {
        minimum: 15_000,
        maximum: 10 * 60_000,
      }),
    },
    compaction: { ...DEFAULT_COMPACTION_CONFIG, ...global?.compaction, ...project?.compaction },
    image: {
      ...image,
      timeoutMs: Number.clamp(image.timeoutMs, { minimum: 30_000, maximum: 5 * 60_000 }),
    },
  };
}

// SAFETY: Boundary decoding validates the value before it is narrowed to this declared contract.
const store = makeScopedConfigStore({
  errorFactory: mapError,
  label: "Better OpenAI",
  spanPrefix: "OpenAIConfig",
  projectConfigDirectory: CONFIG_DIR_NAME,
  basename: CONFIG_BASENAME,
  decode: decodeConfig,
  defaultDocument: () => DEFAULT_CONFIG as JsonObject,
  resolve: resolveConfigFiles,
});

export const {
  configPaths,
  modifyConfig,
  readConfig,
  readRawConfig,
  resolveCommittedConfig,
  resolveConfig,
  writeConfig,
} = store;
