// Public compatibility boundary for settings access before Pi starts a session.
import * as Predicate from "effect/Predicate";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  AgentDirectory,
  nodeFilePlatformLayer,
  piHostLoggerLayer,
  provideBuiltLayer,
} from "pi-cosmic-core";
import { CodePreviewEnvironmentService } from "../config/env";
import { CodePreviewSettingsService } from "../config/service";

const oneShotSettingsLayer = () => {
  const environment = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(
    Object.fromEntries(
      Object.entries(process.env).flatMap(([key, value]) =>
        Predicate.isString(value) ? [[key, value]] : [],
      ),
    ),
  );
  return Layer.merge(
    CodePreviewSettingsService.layer.pipe(
      Layer.provideMerge(CodePreviewEnvironmentService.layerFrom(environment)),
      Layer.provideMerge(AgentDirectory.layerFromHost(getAgentDir)),
      Layer.provide(nodeFilePlatformLayer),
    ),
    piHostLoggerLayer,
  );
};

const oneShotSettingsPermit = Semaphore.makeUnsafe(1);

/** The only detached runner: explicit serialized public pre-session settings compatibility. */
export function runOneShotSettingsEffect<A, E>(
  effect: Effect.Effect<A, E, CodePreviewSettingsService>,
  signal?: AbortSignal,
): Promise<A> {
  const serialized = oneShotSettingsPermit.withPermit(
    effect.pipe(provideBuiltLayer(oneShotSettingsLayer())),
  );
  return Effect.runPromise(serialized, signal ? { signal } : undefined);
}
