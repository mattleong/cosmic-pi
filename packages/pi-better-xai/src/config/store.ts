import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
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
  DEFAULT_FOOTER_CONFIG,
  DEFAULT_USAGE_CONFIG,
  FiniteNumberSchema,
  FooterModeSchema,
  type ResolvedConfig,
} from "./schema.ts";

export class XaiConfigError extends Schema.TaggedErrorClass<XaiConfigError>()("XaiConfigError", {
  operation: Schema.String,
  path: Schema.String,
  message: Schema.String,
}) {}

const mapDocumentError = makeConfigDocumentErrorFactory(XaiConfigError, "Better xAI");

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);

function decodeConfig(value: unknown) {
  const root = decodeTolerantFields(
    value,
    { usage: UnknownRecordSchema, footer: UnknownRecordSchema },
    { path: "config" },
  ).value;
  const usage = decodeTolerantFields(
    root.usage,
    {
      enabled: Schema.Boolean,
      refreshIntervalMs: FiniteNumberSchema,
      showOnlyOnSubscriptionModels: Schema.Boolean,
      showResetTimes: Schema.Boolean,
    },
    { path: "usage" },
  ).value;
  const footer = decodeTolerantFields(
    root.footer,
    { mode: FooterModeSchema },
    { path: "footer" },
  ).value;
  return {
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
    ...(footer.mode !== undefined ? { footer: { mode: footer.mode } } : {}),
  };
}

type ResolvedConfigValues = Pick<ResolvedConfig, "usage" | "footer">;
type DecodedConfig = ReturnType<typeof decodeConfig>;

const defaultConfigValues = (): ResolvedConfigValues => ({
  usage: { ...DEFAULT_USAGE_CONFIG },
  footer: { ...DEFAULT_FOOTER_CONFIG },
});

function overlayConfigValues(
  primary: DecodedConfig | void,
  fallback: ResolvedConfigValues,
): ResolvedConfigValues {
  const usage = { ...fallback.usage, ...primary?.usage };
  return {
    usage: {
      ...usage,
      refreshIntervalMs: Math.max(5_000, usage.refreshIntervalMs),
    },
    footer: { ...fallback.footer, ...primary?.footer },
  };
}

const store = makeScopedConfigStore({
  errorFactory: mapDocumentError,
  label: "Better xAI",
  spanPrefix: "XaiConfig",
  projectConfigDirectory: CONFIG_DIR_NAME,
  basename: CONFIG_BASENAME,
  decode: decodeConfig,
  defaultDocument: (): JsonObject => defaultConfigValues(),
  resolve: (
    metadata: ScopedConfigMetadata,
    project: DecodedConfig | undefined,
    global: DecodedConfig | undefined,
  ): ResolvedConfig => ({
    ...metadata,
    ...overlayConfigValues(project, overlayConfigValues(global, defaultConfigValues())),
  }),
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
