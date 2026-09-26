import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class ModelRegistryAuthError extends Schema.TaggedError<ModelRegistryAuthError>()(
  "ModelRegistryAuthError",
  {
    operation: Schema.Literal("lookup"),
    message: Schema.String,
  },
) {}

type Registry = Pick<ExtensionContext, "modelRegistry">["modelRegistry"];

/**
 * Named Pi boundary for the model registry's credential lookup. Pi resolves, refreshes under its
 * lock, and persists xAI OAuth credentials; a blank key is absent and a rejection is typed.
 */
export class ModelRegistryAuth extends Context.Service<ModelRegistryAuth>()(
  "pi-better-xai/boundary/model-registry-auth/ModelRegistryAuth",
  {
    make: (getRegistry: () => Registry) =>
      Effect.succeed({
        getApiKey: Effect.tryPromise({
          try: () =>
            getRegistry()
              .getProviderAuth("xai")
              .then((result) => result?.auth.apiKey?.trim() || undefined),
          catch: () =>
            new ModelRegistryAuthError({
              operation: "lookup",
              message: "Unable to read xAI credentials.",
            }),
        }),
      }),
  },
) {
  static layer(getRegistry: () => Registry): Layer.Layer<ModelRegistryAuth> {
    return Layer.effect(this, this.make(getRegistry));
  }
}
