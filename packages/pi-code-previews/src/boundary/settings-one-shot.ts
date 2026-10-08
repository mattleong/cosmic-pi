// Public compatibility boundary for settings access before Pi starts a session.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AgentDirectory, nodeFilePlatformLayer, piHostLoggerLayer } from "pi-cosmic-core";
import { CodePreviewSettingsService } from "../config/service";

// A fresh Layer per run: each one-shot call owns its private settings Ref and scope.
const oneShotSettingsLayer = () =>
  Layer.merge(
    CodePreviewSettingsService.layer.pipe(
      Layer.provide(Layer.merge(AgentDirectory.layerFromHost(getAgentDir), nodeFilePlatformLayer)),
    ),
    piHostLoggerLayer,
  );

/** The only detached runner: explicit public pre-session settings compatibility. */
export function runOneShotSettingsEffect<A, E>(
  effect: Effect.Effect<A, E, CodePreviewSettingsService>,
  signal?: AbortSignal,
): Promise<A> {
  return Effect.runPromise(Effect.provide(effect, oneShotSettingsLayer()), { signal });
}
