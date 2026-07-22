// Public compatibility boundary for settings access before Pi starts a session.
// @effect-diagnostics effect/strictEffectProvide:off
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AgentDirectory, nodeFilePlatformLayer } from "pi-cosmic-core";
import { CodePreviewEnvironmentService } from "../config/environment-service";
import { CodePreviewSettingsService } from "../config/service";

const oneShotSettingsLayer = () => {
  const environment = Reflect.get(process, "env") as Readonly<Record<string, string>>;
  return CodePreviewSettingsService.layer.pipe(
    Layer.provideMerge(CodePreviewEnvironmentService.layerFrom(environment)),
    Layer.provideMerge(AgentDirectory.layerFromHost(getAgentDir)),
    Layer.provide(nodeFilePlatformLayer),
  );
};

let oneShotTransition: Promise<unknown> = Promise.resolve();

/** The only detached runner: explicit serialized public pre-session settings compatibility. */
export function runOneShotSettingsEffect<A, E>(
  effect: Effect.Effect<A, E, CodePreviewSettingsService>,
): Promise<A> {
  const result = oneShotTransition.then(
    () => Effect.runPromise(effect.pipe(Effect.provide(oneShotSettingsLayer()))),
    () => Effect.runPromise(effect.pipe(Effect.provide(oneShotSettingsLayer()))),
  );
  oneShotTransition = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
