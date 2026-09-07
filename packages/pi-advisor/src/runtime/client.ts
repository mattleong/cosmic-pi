import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import {
  ModelRuntime,
  type ExtensionContext,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { mergeHeaders } from "pi-cosmic-core";
import { snapshotData } from "../domain/safe-data.ts";
import { ADVISOR_THINKING_LEVEL, type ResolvedAdvisorConfig } from "../config/options.ts";

export const ADVISOR_MODEL_ERROR_KINDS = [
  "authentication",
  "configuration",
  "timeout",
  "unavailable",
  "aborted",
  "response-format",
  "unknown",
] as const;
export type AdvisorModelErrorKind = (typeof ADVISOR_MODEL_ERROR_KINDS)[number];
export class AdvisorModelError extends Schema.TaggedError<AdvisorModelError>()(
  "AdvisorModelError",
  {
    message: Schema.String,
    kind: Schema.optional(Schema.Literals(ADVISOR_MODEL_ERROR_KINDS)),
  },
) {}
const modelError = (message: string, kind: AdvisorModelErrorKind) =>
  new AdvisorModelError({ message, kind });
const StringMapSchema = Schema.Record(Schema.String, Schema.String);
const ProviderHeadersSchema = Schema.Record(Schema.String, Schema.NullOr(Schema.String));
const ParentAuthWireSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    apiKey: Schema.optional(Schema.String),
    headers: Schema.optional(ProviderHeadersSchema),
    env: Schema.optional(StringMapSchema),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);

export interface AdvisorUsageTelemetry {
  cost: number;
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
    return yield* modelError("Advisor model is not configured.", "configuration");
  const providerId = config.provider;
  const modelId = config.model;
  const parentModel = yield* tryModelSync("Advisor model lookup failed.", "unknown", () =>
    ctx.modelRegistry.find(providerId, modelId),
  );
  if (!parentModel)
    return yield* modelError(
      `Configured advisor model ${config.provider}/${config.model} is unavailable.`,
      "unavailable",
    );
  const parentAuthRaw = yield* Effect.tryPromise({
    try: () => ctx.modelRegistry.getApiKeyAndHeaders(parentModel),
    catch: () =>
      modelError(
        "Advisor authentication failed; credentials were not transferred.",
        "authentication",
      ),
  });
  const parentAuthOption = Schema.decodeUnknownOption(ParentAuthWireSchema)(
    snapshotData(parentAuthRaw),
  );
  if (Option.isNone(parentAuthOption))
    return yield* modelError(
      "Advisor authentication returned an invalid response.",
      "authentication",
    );
  const parentAuth = parentAuthOption.value;
  if (!parentAuth.ok)
    return yield* modelError(
      "Advisor authentication failed; credentials were not transferred.",
      "authentication",
    );
  const modelRuntime = yield* Effect.tryPromise({
    try: () => ModelRuntime.create(),
    catch: () => modelError("Advisor child model runtime could not be created.", "unknown"),
  });
  yield* tryModelSync("Advisor provider registration failed.", "unknown", () => {
    let selectedProviderRegistered = false;
    for (const registeredProviderId of ctx.modelRegistry.getRegisteredProviderIds()) {
      const provider = ctx.modelRegistry.getRegisteredProviderConfig(registeredProviderId);
      if (!provider) continue;
      if (registeredProviderId === providerId) selectedProviderRegistered = true;
      modelRuntime.registerProvider(
        registeredProviderId,
        registeredProviderId === providerId && parentAuth.headers
          ? {
              ...provider,
              headers: mergeHeaders(provider.headers, parentAuth.headers),
            }
          : provider,
      );
    }
    const selectedProvider = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
    if (!selectedProviderRegistered && (selectedProvider || parentAuth.headers)) {
      modelRuntime.registerProvider(providerId, {
        ...selectedProvider,
        headers: mergeHeaders(selectedProvider?.headers, parentAuth.headers),
      });
    }
  });
  const usingOAuth = yield* tryModelSync(
    "Advisor authentication mode lookup failed.",
    "authentication",
    () => ctx.modelRegistry.isUsingOAuth(parentModel),
  );
  if (parentAuth.apiKey && !usingOAuth) {
    yield* Effect.tryPromise({
      try: () => modelRuntime.setRuntimeApiKey(providerId, parentAuth.apiKey!),
      catch: () =>
        modelError("Advisor runtime authentication could not be installed.", "authentication"),
    });
  }
  const model = yield* tryModelSync("Advisor child model lookup failed.", "unknown", () =>
    modelRuntime.getModel(providerId, modelId),
  );
  if (!model)
    return yield* modelError(
      `Configured advisor model ${config.provider}/${config.model} is unavailable in the child runtime.`,
      "unavailable",
    );
  const childAuth = yield* Effect.tryPromise({
    try: () => modelRuntime.getAuth(model),
    catch: () => modelError("Advisor child authentication lookup failed.", "authentication"),
  });
  if (!childAuth) {
    const runtimeOnly = parentAuth.headers || parentAuth.env;
    return yield* modelError(
      runtimeOnly
        ? "Advisor authentication uses runtime-only headers or environment values that public Pi APIs cannot transfer to an AgentSession."
        : "Advisor authentication is unavailable in the child runtime.",
      "authentication",
    );
  }
  const thinkingLevel = yield* tryModelSync(
    "Advisor thinking level selection failed.",
    "unknown",
    () => clampThinkingLevel(model, ADVISOR_THINKING_LEVEL),
  );
  return {
    modelRuntime,
    model,
    thinkingLevel,
  } satisfies AdvisorChildModel;
});
const tryModelSync = <A>(message: string, kind: AdvisorModelErrorKind, operation: () => A) =>
  Effect.try({ try: operation, catch: () => modelError(message, kind) });
