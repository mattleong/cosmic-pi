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
  DEFAULT_FOOTER_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  DEFAULT_USAGE_CONFIG,
  FooterModeSchema,
  ImageOutputFormatSchema,
  ImageSaveModeSchema,
  type ConfigFile,
  type ImageConfig,
  type ResolvedConfig,
  type UsageConfig,
} from "./schema.ts";

export class OpenAIConfigError extends Schema.TaggedError<OpenAIConfigError>()(
  "OpenAIConfigError",
  { operation: Schema.String, path: Schema.String, message: Schema.String },
) {}

const mapError = makeConfigDocumentErrorFactory(OpenAIConfigError, "Better OpenAI");

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const FiniteNumberSchema = Schema.Number.check(Schema.isFinite());

/** Tolerant field-level wire decode: one malformed field never discards valid siblings. */
function decodeConfig<ValueInput>(value: ValueInput): ConfigFile {
  const root = decodeTolerantFields(
    value,
    {
      persistState: Schema.Boolean,
      active: Schema.Boolean,
      desiredActive: Schema.Boolean,
      usage: UnknownRecordSchema,
      footer: UnknownRecordSchema,
      compaction: UnknownRecordSchema,
      image: UnknownRecordSchema,
    },
    { path: "config" },
  ).value;
  // SAFETY: Boundary decoding validates the value before it is narrowed to this declared contract.
  const usage = decodeTolerantFields(
    root.usage,
    {
      enabled: Schema.Boolean,
      refreshIntervalMs: FiniteNumberSchema,
      showOnlyOnSubscriptionModels: Schema.Boolean,
      showResetTimes: Schema.Boolean,
    },
    { path: "usage" },
  ).value as UsageConfig;
  const footer = decodeTolerantFields(
    root.footer,
    { mode: FooterModeSchema },
    { path: "footer" },
  ).value;
  const compaction = decodeTolerantFields(
    root.compaction,
    { enabled: Schema.Boolean },
    { path: "compaction" },
  ).value;
  const imageFields = decodeTolerantFields(
    root.image,
    {
      enabled: Schema.Boolean,
      defaultModel: Schema.String,
      defaultSave: ImageSaveModeSchema,
      outputFormat: ImageOutputFormatSchema,
      timeoutMs: FiniteNumberSchema,
    },
    { path: "image" },
  ).value;
  const defaultModel = imageFields.defaultModel?.trim();
  const image: ImageConfig = {
    ...imageFields,
    ...(defaultModel ? { defaultModel } : { defaultModel: undefined }),
  };
  return (() => {
    const objectPart2666_0 = {};
    const objectPart2666_1 =
      root.persistState !== undefined
        ? { ...objectPart2666_0, persistState: root.persistState }
        : objectPart2666_0;
    const objectPart2666_2 =
      root.active !== undefined ? { ...objectPart2666_1, active: root.active } : objectPart2666_1;
    const objectPart2666_3 =
      root.desiredActive !== undefined
        ? { ...objectPart2666_2, desiredActive: root.desiredActive }
        : objectPart2666_2;
    const objectPart2666_4 = Object.keys(usage).length
      ? { ...objectPart2666_3, usage }
      : objectPart2666_3;
    const objectPart2666_5 =
      footer.mode !== undefined
        ? { ...objectPart2666_4, footer: { mode: footer.mode } }
        : objectPart2666_4;
    const objectPart2666_6 =
      compaction.enabled !== undefined
        ? { ...objectPart2666_5, compaction: { enabled: compaction.enabled } }
        : objectPart2666_5;
    const objectPart2666_7 = Object.values(image).some((field) => field !== undefined)
      ? { ...objectPart2666_6, image }
      : objectPart2666_6;
    return objectPart2666_7;
  })();
}

function resolveConfigFiles(
  metadata: ScopedConfigMetadata,
  project: ConfigFile | undefined,
  global: ConfigFile | undefined,
): ResolvedConfig {
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
    active: project?.active ?? global?.active ?? desiredActive,
    desiredActive,
    usage: {
      enabled: project?.usage?.enabled ?? global?.usage?.enabled ?? DEFAULT_USAGE_CONFIG.enabled,
      refreshIntervalMs: Number.clamp(
        project?.usage?.refreshIntervalMs ??
          global?.usage?.refreshIntervalMs ??
          DEFAULT_USAGE_CONFIG.refreshIntervalMs,
        { minimum: 15_000, maximum: 10 * 60_000 },
      ),
      showOnlyOnSubscriptionModels:
        project?.usage?.showOnlyOnSubscriptionModels ??
        global?.usage?.showOnlyOnSubscriptionModels ??
        DEFAULT_USAGE_CONFIG.showOnlyOnSubscriptionModels,
      showResetTimes:
        project?.usage?.showResetTimes ??
        global?.usage?.showResetTimes ??
        DEFAULT_USAGE_CONFIG.showResetTimes,
    },
    footer: {
      mode: project?.footer?.mode ?? global?.footer?.mode ?? DEFAULT_FOOTER_CONFIG.mode,
    },
    compaction: {
      enabled:
        project?.compaction?.enabled ??
        global?.compaction?.enabled ??
        DEFAULT_COMPACTION_CONFIG.enabled,
    },
    image: {
      enabled: project?.image?.enabled ?? global?.image?.enabled ?? DEFAULT_IMAGE_CONFIG.enabled,
      defaultModel:
        project?.image?.defaultModel ??
        global?.image?.defaultModel ??
        DEFAULT_IMAGE_CONFIG.defaultModel,
      defaultSave:
        project?.image?.defaultSave ??
        global?.image?.defaultSave ??
        DEFAULT_IMAGE_CONFIG.defaultSave,
      outputFormat:
        project?.image?.outputFormat ??
        global?.image?.outputFormat ??
        DEFAULT_IMAGE_CONFIG.outputFormat,
      timeoutMs: Number.clamp(
        project?.image?.timeoutMs ?? global?.image?.timeoutMs ?? DEFAULT_IMAGE_CONFIG.timeoutMs,
        { minimum: 30_000, maximum: 5 * 60_000 },
      ),
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
