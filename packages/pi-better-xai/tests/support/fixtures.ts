import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ModelRegistryAuth } from "../../src/boundary/model-registry-auth.ts";

// Pure leak-check serialization stays outside Effect code on purpose: it scans opaque
// runtime values (tagged errors, redacted credentials) for secret fragments.
export const serializedSnapshot = <Value>(value: Value): string => JSON.stringify(value) ?? "";

export const registryEffectLayer = (getApiKey: Effect.Effect<string | undefined>) =>
  Layer.succeed(
    ModelRegistryAuth,
    ModelRegistryAuth.of({
      getApiKey,
      isUsingOAuth: () => Effect.succeed(true),
    }),
  );

export const registryLayer = (token?: string) => registryEffectLayer(Effect.succeed(token));
