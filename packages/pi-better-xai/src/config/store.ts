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

export class XaiConfigError extends Schema.TaggedError<XaiConfigError>()("XaiConfigError", {
  operation: Schema.String,
  path: Schema.String,
  message: Schema.String,
}) {}

const mapDocumentError = makeConfigDocumentErrorFactory(XaiConfigError, "Better xAI");

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);

type DecodedConfig = {
  usage: Partial<ResolvedConfig["usage"]>;
  footer: Partial<ResolvedConfig["footer"]>;
};

function decodeConfig<ValueInput>(value: ValueInput): DecodedConfig {
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
  return { usage, footer };
}

const store = makeScopedConfigStore({
  errorFactory: mapDocumentError,
  label: "Better xAI",
  spanPrefix: "XaiConfig",
  projectConfigDirectory: CONFIG_DIR_NAME,
  basename: CONFIG_BASENAME,
  decode: decodeConfig,
  defaultDocument: (): JsonObject => ({
    usage: { ...DEFAULT_USAGE_CONFIG },
    footer: { ...DEFAULT_FOOTER_CONFIG },
  }),
  resolve: (
    metadata: ScopedConfigMetadata,
    project: DecodedConfig | undefined,
    global: DecodedConfig | undefined,
  ): ResolvedConfig => {
    const usage = {
      ...DEFAULT_USAGE_CONFIG,
      ...global?.usage,
      ...project?.usage,
    };
    return {
      ...metadata,
      usage: {
        ...usage,
        refreshIntervalMs: Math.max(5_000, usage.refreshIntervalMs),
      },
      footer: {
        ...DEFAULT_FOOTER_CONFIG,
        ...global?.footer,
        ...project?.footer,
      },
    };
  },
});

export const { modifyConfig, readRawConfig, resolveCommittedConfig, resolveConfig } = store;
