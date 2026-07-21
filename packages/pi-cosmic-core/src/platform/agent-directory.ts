import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class AgentDirectoryError extends Schema.TaggedErrorClass<AgentDirectoryError>()(
  "AgentDirectoryError",
  { message: Schema.String },
) {}

export class AgentDirectory extends Context.Service<AgentDirectory, string>()(
  "pi-cosmic-core/platform/agent-directory/AgentDirectory",
) {
  static readonly layer = (directory: string): Layer.Layer<AgentDirectory> =>
    Layer.succeed(this, directory);

  static readonly layerEffect = <E, R>(
    effect: Effect.Effect<string, E, R>,
  ): Layer.Layer<AgentDirectory, E, R> => Layer.effect(this, effect);

  static readonly layerFromHost = (
    load: () => string,
  ): Layer.Layer<AgentDirectory, AgentDirectoryError> =>
    this.layerEffect(
      Effect.try({
        try: load,
        catch: () =>
          new AgentDirectoryError({ message: "Unable to resolve the Pi agent directory." }),
      }),
    );
}
