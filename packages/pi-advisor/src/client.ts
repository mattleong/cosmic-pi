import { clampThinkingLevel, streamSimple } from "@earendil-works/pi-ai/compat";
import {
  ModelRuntime,
  type ExtensionContext,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FAST_SERVICE_TIER, supportsFastModel } from "pi-better-openai/fast-models";
import { standaloneAdvisorExecutor } from "./boundary/executor.ts";
import { snapshotData } from "./boundary/safe-data.ts";
import type { ResolvedAdvisorConfig } from "./config.ts";

export class AdvisorModelError extends Schema.TaggedErrorClass<AdvisorModelError>()(
  "AdvisorModelError",
  { message: Schema.String },
) {}
const modelError = (message: string) => new AdvisorModelError({ message });
const StringMapSchema = Schema.Record(Schema.String, Schema.String);
const ParentAuthWireSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    apiKey: Schema.optional(Schema.String),
    headers: Schema.optional(StringMapSchema),
    env: Schema.optional(StringMapSchema),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
export interface AdvisorUsageTelemetry {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
export interface AdvisorChildModel {
  modelRuntime: ModelRuntime;
  model: NonNullable<ReturnType<ModelRegistry["find"]>>;
  thinkingLevel: ReturnType<typeof clampThinkingLevel>;
}
export const createAdvisorChildModelEffect = Effect.fn("AdvisorClient.createChild")(function* (
  ctx: Pick<ExtensionContext, "modelRegistry">,
  config: ResolvedAdvisorConfig,
) {
  if (!config.provider || !config.model)
    return yield* modelError("Advisor model is not configured.");
  const parentModel = ctx.modelRegistry.find(config.provider, config.model);
  if (!parentModel)
    return yield* modelError(
      `Configured advisor model ${config.provider}/${config.model} is unavailable.`,
    );
  const parentAuthRaw = yield* Effect.tryPromise({
    try: () => ctx.modelRegistry.getApiKeyAndHeaders(parentModel),
    catch: () => modelError("Advisor authentication failed; credentials were not transferred."),
  });
  const parentAuthOption = Schema.decodeUnknownOption(ParentAuthWireSchema)(
    snapshotData(parentAuthRaw),
  );
  if (Option.isNone(parentAuthOption))
    return yield* modelError("Advisor authentication returned an invalid response.");
  const parentAuth = parentAuthOption.value;
  if (!parentAuth.ok)
    return yield* modelError("Advisor authentication failed; credentials were not transferred.");
  const modelRuntime = yield* Effect.tryPromise({
    try: () => ModelRuntime.create(),
    catch: () => modelError("Advisor child model runtime could not be created."),
  });
  let selectedProviderRegistered = false;
  for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
    const provider = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
    if (!provider) continue;
    if (providerId === config.provider) selectedProviderRegistered = true;
    modelRuntime.registerProvider(
      providerId,
      providerId === config.provider && parentAuth.headers
        ? { ...provider, headers: { ...provider.headers, ...parentAuth.headers } }
        : provider,
    );
  }
  const selectedProvider = ctx.modelRegistry.getRegisteredProviderConfig(config.provider);
  if (config.fastMode && supportsFastModel(config.provider, config.model)) {
    modelRuntime.registerProvider(config.provider, {
      ...selectedProvider,
      api: parentModel.api,
      headers: { ...selectedProvider?.headers, ...parentAuth.headers },
      streamSimple: (model, context, options) =>
        streamSimple(model, context, { ...options, onPayload: applyFastServiceTier }),
    });
  } else if (!selectedProviderRegistered && (selectedProvider || parentAuth.headers)) {
    modelRuntime.registerProvider(config.provider, {
      ...selectedProvider,
      headers: { ...selectedProvider?.headers, ...parentAuth.headers },
    });
  }
  if (parentAuth.apiKey && !ctx.modelRegistry.isUsingOAuth(parentModel)) {
    yield* Effect.tryPromise({
      try: () => modelRuntime.setRuntimeApiKey(config.provider!, parentAuth.apiKey!),
      catch: () => modelError("Advisor runtime authentication could not be installed."),
    });
  }
  const model = modelRuntime.getModel(config.provider, config.model);
  if (!model)
    return yield* modelError(
      `Configured advisor model ${config.provider}/${config.model} is unavailable in the child runtime.`,
    );
  const childAuth = yield* Effect.tryPromise({
    try: () => modelRuntime.getAuth(model),
    catch: () => modelError("Advisor child authentication lookup failed."),
  });
  if (!childAuth) {
    const runtimeOnly = parentAuth.headers || parentAuth.env;
    return yield* modelError(
      runtimeOnly
        ? "Advisor authentication uses runtime-only headers or environment values that public Pi APIs cannot transfer to an AgentSession."
        : "Advisor authentication is unavailable in the child runtime.",
    );
  }
  return {
    modelRuntime,
    model,
    thinkingLevel: clampThinkingLevel(model, config.thinkingLevel),
  } satisfies AdvisorChildModel;
});
export function createAdvisorChildModel(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  config: ResolvedAdvisorConfig,
): Promise<AdvisorChildModel> {
  return standaloneAdvisorExecutor.run(createAdvisorChildModelEffect(ctx, config));
}
function applyFastServiceTier(payload: unknown): unknown | undefined {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? { ...payload, service_tier: FAST_SERVICE_TIER }
    : undefined;
}
export const _clientTest = { applyFastServiceTier };
