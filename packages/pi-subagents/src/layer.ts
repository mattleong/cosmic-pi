import * as Layer from "effect/Layer";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { subagentBackendRegistryLayer } from "./backend/local.ts";
import { ChildProcess } from "./boundary/child-process.ts";
import { HerdrCli } from "./boundary/herdr-cli.ts";
import { HerdrHarness } from "./boundary/herdr-harness.ts";
import { HerdrHost } from "./boundary/herdr-host.ts";
import { LocalCliProcess } from "./boundary/local-cli-process.ts";
import { SupervisorChannel } from "./boundary/supervisor-channel.ts";
import { WriterLeaseService } from "./boundary/writer-lease.ts";
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
  const herdrBoundaries = Layer.merge(
    HerdrCli.layer(),
    HerdrHarness.layer({ agentDirectory: options.agentDirectory }),
  );
  const herdrHost = HerdrHost.layer.pipe(Layer.provide(herdrBoundaries));
  const backendBoundaries = Layer.mergeAll(
    ChildProcess.layer,
    LocalCliProcess.layer({ agentDirectory: options.agentDirectory }),
    SupervisorChannel.layer({ agentDirectory: options.agentDirectory }),
    herdrHost,
  );
  const backend = subagentBackendRegistryLayer.pipe(Layer.provide(backendBoundaries));
  const writerLeases = WriterLeaseService.layer({ agentDirectory: options.agentDirectory });
  const service = SubagentService.layer({ publish: options.publish, notify: options.notify }).pipe(
    Layer.provide(Layer.merge(backend, writerLeases)),
  );
  // Layer memoization shares both persistence and the backend registry with host preflight/service use.
  return Layer.mergeAll(service, profiles, configStore, backend);
};

export type SubagentApplicationLayer = ReturnType<typeof makeSubagentLayer>;
export type SubagentApplication = Layer.Success<SubagentApplicationLayer>;
export type SubagentRuntimeError = Layer.Error<SubagentApplicationLayer>;
