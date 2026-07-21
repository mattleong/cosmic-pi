import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class ModelRegistryAuthError extends Schema.TaggedErrorClass<ModelRegistryAuthError>()(
  "ModelRegistryAuthError",
  {
    operation: Schema.Literal("lookup"),
    message: Schema.String,
  },
) {}

export interface ModelRegistryAuthShape {
  readonly getApiKey: Effect.Effect<string | undefined, ModelRegistryAuthError>;
}

/** Named Pi boundary for the model registry's Promise-returning credential lookup. */
export class ModelRegistryAuth extends Context.Service<ModelRegistryAuth, ModelRegistryAuthShape>()(
  "pi-better-xai/boundary/model-registry-auth/ModelRegistryAuth",
) {
  static make(
    getRegistry: () => Pick<ExtensionContext, "modelRegistry">["modelRegistry"],
  ): ModelRegistryAuthShape {
    return this.of({
      getApiKey: Effect.tryPromise({
        try: () => getRegistry().getApiKeyForProvider("xai"),
        catch: () =>
          new ModelRegistryAuthError({
            operation: "lookup",
            message: "Unable to read xAI credentials.",
          }),
      }),
    });
  }

  static layer(
    getRegistry: () => Pick<ExtensionContext, "modelRegistry">["modelRegistry"],
  ): Layer.Layer<ModelRegistryAuth> {
    return Layer.succeed(this, this.make(getRegistry));
  }
}
