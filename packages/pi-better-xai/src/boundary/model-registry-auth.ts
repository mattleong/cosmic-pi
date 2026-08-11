import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class ModelRegistryAuthError extends Schema.TaggedErrorClass<ModelRegistryAuthError>()(
  "ModelRegistryAuthError",
  {
    operation: Schema.Literals(["lookup", "oauth-status"]),
    message: Schema.String,
  },
) {}

type Registry = Pick<ExtensionContext, "modelRegistry">["modelRegistry"];
type Model = NonNullable<ExtensionContext["model"]>;

export interface ModelRegistryAuthShape {
  readonly getApiKey: Effect.Effect<string | undefined, ModelRegistryAuthError>;
  readonly isUsingOAuth: (model: Model) => Effect.Effect<boolean, ModelRegistryAuthError>;
}

/** Synchronous Pi-renderer boundary. Host failures fail closed and never escape rendering. */
export { isUsingOAuthAtHostBoundary } from "pi-cosmic-core";

/** Named Pi boundary for the model registry's Promise-returning credential lookup. */
export class ModelRegistryAuth extends Context.Service<ModelRegistryAuth, ModelRegistryAuthShape>()(
  "pi-better-xai/boundary/model-registry-auth/ModelRegistryAuth",
) {
  static make(getRegistry: () => Registry): ModelRegistryAuthShape {
    return this.of({
      getApiKey: Effect.tryPromise({
        try: () => getRegistry().getApiKeyForProvider("xai"),
        catch: () =>
          new ModelRegistryAuthError({
            operation: "lookup",
            message: "Unable to read xAI credentials.",
          }),
      }),
      isUsingOAuth: (model) =>
        Effect.try({
          try: () => getRegistry().isUsingOAuth(model),
          catch: () =>
            new ModelRegistryAuthError({
              operation: "oauth-status",
              message: "Unable to inspect xAI authentication status.",
            }),
        }),
    });
  }

  static layer(getRegistry: () => Registry): Layer.Layer<ModelRegistryAuth> {
    return Layer.succeed(this, this.make(getRegistry));
  }
}
