import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Schema from "effect/Schema";
import { decodeTolerantFields, makeScopedConfigStore, type JsonObject } from "pi-cosmic-core";
import {
  CONFIG_BASENAME,
  DEFAULT_USAGE_CONFIG,
  FiniteNumberSchema,
  type ResolvedConfig,
} from "./schema.ts";

export class XaiConfigError extends Schema.TaggedError<XaiConfigError>()("XaiConfigError", {
  operation: Schema.String,
  path: Schema.String,
  message: Schema.String,
}) {}

function decodeConfig<ValueInput>(value: ValueInput) {
  const root = decodeTolerantFields(
    value,
    { usage: Schema.Record(Schema.String, Schema.Unknown) },
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
  return { usage };
}

const store = makeScopedConfigStore({
  error: XaiConfigError,
  label: "Better xAI",
  spanPrefix: "XaiConfig",
  projectConfigDirectory: CONFIG_DIR_NAME,
  basename: CONFIG_BASENAME,
  decode: decodeConfig,
  defaultDocument: (): JsonObject => ({
    usage: { ...DEFAULT_USAGE_CONFIG },
  }),
  resolve: (
    metadata,
    project: ReturnType<typeof decodeConfig> | undefined,
    global: ReturnType<typeof decodeConfig> | undefined,
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
    };
  },
});

export const { modifyConfig, readRawConfig, resolveCommittedConfig, resolveConfig } = store;
