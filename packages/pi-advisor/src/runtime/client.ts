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
import { standaloneAdvisorExecutor } from "../boundary/executor.ts";
import { snapshotData } from "../domain/safe-data.ts";
import type { ResolvedAdvisorConfig } from "../config/options.ts";

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
  const providerId = config.provider;
  const modelId = config.model;
  const parentModel = yield* tryModelSync("Advisor model lookup failed.", () =>
    ctx.modelRegistry.find(providerId, modelId),
  );
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
  yield* tryModelSync("Advisor provider registration failed.", () => {
    let selectedProviderRegistered = false;
    for (const registeredProviderId of ctx.modelRegistry.getRegisteredProviderIds()) {
      const provider = ctx.modelRegistry.getRegisteredProviderConfig(registeredProviderId);
      if (!provider) continue;
      if (registeredProviderId === providerId) selectedProviderRegistered = true;
      modelRuntime.registerProvider(
        registeredProviderId,
        registeredProviderId === providerId && parentAuth.headers
          ? { ...provider, headers: { ...provider.headers, ...parentAuth.headers } }
          : provider,
      );
    }
    const selectedProvider = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
    if (config.fastMode && supportsFastModel(providerId, modelId)) {
      modelRuntime.registerProvider(providerId, {
        ...selectedProvider,
        api: parentModel.api,
        headers: { ...selectedProvider?.headers, ...parentAuth.headers },
        streamSimple: (model, context, options) =>
          streamSimple(model, context, { ...options, onPayload: applyFastServiceTier }),
      });
    } else if (!selectedProviderRegistered && (selectedProvider || parentAuth.headers)) {
      modelRuntime.registerProvider(providerId, {
        ...selectedProvider,
        headers: { ...selectedProvider?.headers, ...parentAuth.headers },
      });
    }
  });
  const usingOAuth = yield* tryModelSync("Advisor authentication mode lookup failed.", () =>
    ctx.modelRegistry.isUsingOAuth(parentModel),
  );
  if (parentAuth.apiKey && !usingOAuth) {
    yield* Effect.tryPromise({
      try: () => modelRuntime.setRuntimeApiKey(providerId, parentAuth.apiKey!),
      catch: () => modelError("Advisor runtime authentication could not be installed."),
    });
  }
  const model = yield* tryModelSync("Advisor child model lookup failed.", () =>
    modelRuntime.getModel(providerId, modelId),
  );
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
  const thinkingLevel = yield* tryModelSync("Advisor thinking level selection failed.", () =>
    clampThinkingLevel(model, config.thinkingLevel),
  );
  return {
    modelRuntime,
    model,
    thinkingLevel,
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
const tryModelSync = <A>(message: string, operation: () => A) =>
  Effect.try({ try: operation, catch: () => modelError(message) });
export const _clientTest = { applyFastServiceTier };
