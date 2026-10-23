import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AgentDirectory } from "pi-cosmic-core/platform/agent-directory";
import { nodeFilePlatformLayer } from "pi-cosmic-core/platform/node-file";
import { piHostLoggerLayer } from "pi-cosmic-core/runtime";
import { CodePreviewSettingsService } from "../config/service";

const oneShotSettingsLayer = () =>
  Layer.merge(
    CodePreviewSettingsService.layer.pipe(
      Layer.provide(Layer.merge(AgentDirectory.layerFromHost(getAgentDir), nodeFilePlatformLayer)),
    ),
    piHostLoggerLayer,
  );

export function runOneShotSettingsEffect<A, E>(
  effect: Effect.Effect<A, E, CodePreviewSettingsService>,
  signal?: AbortSignal,
): Promise<A> {
  return Effect.runPromise(Effect.provide(effect, oneShotSettingsLayer()), { signal });
}
