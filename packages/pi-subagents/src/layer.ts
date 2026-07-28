import * as Layer from "effect/Layer";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { ChildProcess } from "./boundary/child-process.ts";
import type {
  SubagentNotification,
  SubagentNotificationDelivery,
} from "./boundary/host-notifier.ts";
import { subagentConfigStoreLayer } from "./config/store.ts";
import { subagentProfileServiceLayer } from "./profiles/service.ts";
import type { SubagentProjection } from "./run/model.ts";
import { SubagentService } from "./run/service.ts";

export interface SubagentLayerOptions {
  readonly cwd: string;
  readonly agentDirectory: string;
  readonly projectTrusted: boolean;
  readonly publish: (projection: SubagentProjection) => void;
  readonly notify: (notification: SubagentNotification) => SubagentNotificationDelivery | undefined;
}

export const makeSubagentLayer = (options: SubagentLayerOptions) => {
  // The store remains the single persistence door and is exposed for the human settings command.
  const configStore = subagentConfigStoreLayer.pipe(Layer.provide(nodeFilePlatformLayer));
  const profiles = subagentProfileServiceLayer(options).pipe(Layer.provide(configStore));
  const service = SubagentService.layer({ publish: options.publish, notify: options.notify }).pipe(
    Layer.provide(Layer.merge(ChildProcess.layer, profiles)),
  );
  // Layer memoization shares the single profiles/config-store construction between usages.
  return Layer.mergeAll(service, profiles, configStore);
};

export type SubagentApplicationLayer = ReturnType<typeof makeSubagentLayer>;
export type SubagentApplication = Layer.Success<SubagentApplicationLayer>;
export type SubagentRuntimeError = Layer.Error<SubagentApplicationLayer>;
