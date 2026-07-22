// Public compatibility boundary for settings access before Pi starts a session.
// @effect-diagnostics effect/strictEffectProvide:off
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AgentDirectory, nodeFilePlatformLayer, piHostLoggerLayer } from "pi-cosmic-core";
import { CodePreviewEnvironmentService } from "../config/environment-service";
import { CodePreviewSettingsService } from "../config/service";

const oneShotSettingsLayer = () => {
  const environment = Reflect.get(process, "env") as Readonly<Record<string, string>>;
  return Layer.merge(
    CodePreviewSettingsService.layer.pipe(
      Layer.provideMerge(CodePreviewEnvironmentService.layerFrom(environment)),
      Layer.provideMerge(AgentDirectory.layerFromHost(getAgentDir)),
      Layer.provide(nodeFilePlatformLayer),
    ),
    piHostLoggerLayer,
  );
};

let oneShotTransition: Promise<unknown> = Promise.resolve();

/** The only detached runner: explicit serialized public pre-session settings compatibility. */
export function runOneShotSettingsEffect<A, E>(
  effect: Effect.Effect<A, E, CodePreviewSettingsService>,
): Promise<A> {
  const run = () => Effect.runPromise(effect.pipe(Effect.provide(oneShotSettingsLayer())));
  const result = oneShotTransition.then(run, run);
  oneShotTransition = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
