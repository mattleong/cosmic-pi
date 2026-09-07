import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class ModelRegistryAuthError extends Schema.TaggedError<ModelRegistryAuthError>()(
  "ModelRegistryAuthError",
  {
    operation: Schema.Literals(["lookup", "oauth-status"]),
    message: Schema.String,
  },
) {}

type Registry = Pick<ExtensionContext, "modelRegistry">["modelRegistry"];
type Model = NonNullable<ExtensionContext["model"]>;

/** Named Pi boundary for the model registry's Promise-returning credential lookup. */
export class ModelRegistryAuth extends Context.Service<ModelRegistryAuth>()(
  "pi-better-xai/boundary/model-registry-auth/ModelRegistryAuth",
  {
    make: (getRegistry: () => Registry) =>
      Effect.succeed({
        getApiKey: Effect.tryPromise({
          try: () => getRegistry().getApiKeyForProvider("xai"),
          catch: () =>
            new ModelRegistryAuthError({
              operation: "lookup",
              message: "Unable to read xAI credentials.",
            }),
        }),
        isUsingOAuth: (model: Model) =>
          Effect.try({
            try: () => getRegistry().isUsingOAuth(model),
            catch: () =>
              new ModelRegistryAuthError({
                operation: "oauth-status",
                message: "Unable to inspect xAI authentication status.",
              }),
          }),
      }),
  },
) {
  static layer(getRegistry: () => Registry): Layer.Layer<ModelRegistryAuth> {
    return Layer.effect(this, this.make(getRegistry));
  }
}
