// Public compatibility boundary for settings access before Pi starts a session.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AgentDirectory, nodeFilePlatformLayer, piHostLoggerLayer } from "pi-cosmic-core";
import { CodePreviewSettingsService } from "../config/service";

const oneShotSettingsLayer = () =>
  Layer.merge(
    CodePreviewSettingsService.layer.pipe(
      Layer.provideMerge(AgentDirectory.layerFromHost(getAgentDir)),
      Layer.provide(nodeFilePlatformLayer),
    ),
    piHostLoggerLayer,
  );

/** The only detached runner: explicit public pre-session settings compatibility. */
export function runOneShotSettingsEffect<A, E>(
  effect: Effect.Effect<A, E, CodePreviewSettingsService>,
  signal?: AbortSignal,
): Promise<A> {
  const program = Effect.scoped(
    Effect.flatMap(Layer.build(oneShotSettingsLayer()), (services) =>
      Effect.provide(effect, services),
    ),
  );
  return Effect.runPromise(program, signal ? { signal } : undefined);
}
