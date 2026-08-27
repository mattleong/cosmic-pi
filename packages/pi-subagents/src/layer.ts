import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { makeHerdrBackendDriver } from "./backend/herdr.ts";
import { makeLocalClaudeBackendDriver } from "./backend/local-claude.ts";
import { makeLocalCodexBackendDriver } from "./backend/local-codex.ts";
import { makeLocalPiBackendDriver } from "./backend/local-pi.ts";
import { makeSubagentBackendRegistry, SubagentBackendRegistry } from "./backend/service.ts";
import { ChildProcess } from "./boundary/child-process.ts";
import { HerdrCli } from "./boundary/herdr-cli.ts";
import { captureHerdrEnvironment } from "./boundary/herdr-environment.ts";
import { HerdrHarness } from "./boundary/herdr-harness.ts";
import { HerdrHost } from "./boundary/herdr-host.ts";
import { LocalCliProcess } from "./boundary/local-cli-process.ts";
import { NativeModelCatalog } from "./boundary/native-model-catalog.ts";
import { SupervisorChannel } from "./boundary/supervisor-channel.ts";
import { WriterLeaseService } from "./boundary/writer-lease.ts";
import type {
  SubagentNotification,
  SubagentNotificationDelivery,
} from "./boundary/host-notifier.ts";
import type { ResolvedSubagentConfig } from "./config/options.ts";
import { subagentConfigStoreLayer } from "./config/store.ts";
import { subagentProfileServiceLayer } from "./profiles/service.ts";
import type { SessionProfileOverrideSeed } from "./profiles/session-overrides.ts";
import type { SubagentProjection } from "./run/model.ts";
import { SubagentService, type SubagentServiceOptions } from "./run/service.ts";

/** One memoized registry owns all six implemented drivers and their shared boundary services. */
const subagentBackendRegistryLayer = Layer.effect(
  SubagentBackendRegistry,
  Effect.gen(function* () {
    const children = yield* ChildProcess;
    const localCli = yield* LocalCliProcess;
    const supervisor = yield* SupervisorChannel;
    const herdr = yield* HerdrHost;
    return makeSubagentBackendRegistry([
      makeLocalPiBackendDriver(children),
      makeLocalClaudeBackendDriver(localCli, supervisor),
      makeLocalCodexBackendDriver(localCli, supervisor),
      makeHerdrBackendDriver("pi", herdr, supervisor),
      makeHerdrBackendDriver("claude", herdr, supervisor),
      makeHerdrBackendDriver("codex", herdr, supervisor),
    ]);
  }),
);

export interface SubagentLayerOptions {
  readonly cwd: string;
  readonly agentDirectory: string;
  readonly projectTrusted: boolean;
  readonly sessionBaseConfig?: ResolvedSubagentConfig | undefined;
  readonly publishSessionBaseConfig?: ((config: ResolvedSubagentConfig) => void) | undefined;
  readonly initialSessionOverrides?: SessionProfileOverrideSeed | undefined;
  readonly publishSessionOverrides?: ((seed: SessionProfileOverrideSeed) => void) | undefined;
  readonly publish: (projection: SubagentProjection) => void;
  readonly notify: (notification: SubagentNotification) => SubagentNotificationDelivery | undefined;
  readonly proxyHandler?: SubagentServiceOptions["proxyHandler"] | undefined;
}

export const makeSubagentLayer = (options: SubagentLayerOptions) => {
  // The store remains the single persistence door and is exposed for the human settings command.
  const configStore = subagentConfigStoreLayer.pipe(Layer.provide(nodeFilePlatformLayer));
  const profiles = subagentProfileServiceLayer(
    (() => {
      const baseResult = { ...options };
      const withBaseConfig = options.sessionBaseConfig
        ? { ...baseResult, baseConfig: options.sessionBaseConfig }
        : baseResult;
      const withPublishBaseConfig = options.publishSessionBaseConfig
        ? { ...withBaseConfig, publishBaseConfig: options.publishSessionBaseConfig }
        : withBaseConfig;
      return withPublishBaseConfig;
    })(),
  ).pipe(Layer.provide(configStore));
  const herdrEnvironment = captureHerdrEnvironment();
  const herdrBoundaries = Layer.merge(
    HerdrCli.layer({ environment: herdrEnvironment }),
    HerdrHarness.layer({
      agentDirectory: options.agentDirectory,
      environment: herdrEnvironment,
    }),
  );
  const herdrHost = HerdrHost.layer.pipe(Layer.provide(herdrBoundaries));
  const backendBoundaries = Layer.mergeAll(
    ChildProcess.layer({ agentDirectory: options.agentDirectory }),
    LocalCliProcess.layer({ agentDirectory: options.agentDirectory }),
    SupervisorChannel.layer({ agentDirectory: options.agentDirectory }),
    herdrHost,
  );
  const backend = subagentBackendRegistryLayer.pipe(Layer.provide(backendBoundaries));
  const nativeModelCatalog = NativeModelCatalog.layer({
    agentDirectory: options.agentDirectory,
  });
  const writerLeases = WriterLeaseService.layer({ agentDirectory: options.agentDirectory });
  const serviceOptions: SubagentServiceOptions = {
    publish: options.publish,
    notify: options.notify,
  };
  const service = SubagentService.layer(
    options.proxyHandler
      ? { ...serviceOptions, proxyHandler: options.proxyHandler }
      : serviceOptions,
  ).pipe(Layer.provide(Layer.mergeAll(backend, writerLeases, profiles)));
  // Layer memoization shares both persistence and the backend registry with host preflight/service use.
  return Layer.mergeAll(service, profiles, configStore, backend, nativeModelCatalog);
};

export type SubagentApplicationLayer = ReturnType<typeof makeSubagentLayer>;
export type SubagentApplication = Layer.Success<SubagentApplicationLayer>;
export type SubagentRuntimeError = Layer.Error<SubagentApplicationLayer>;
