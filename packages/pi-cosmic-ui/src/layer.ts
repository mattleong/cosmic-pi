import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import { AgentDirectory, nodeFilePlatformLayer, PiApi } from "pi-cosmic-core";
import {
  HostCallbackBoundary,
  type HostCallbackBoundaryContract,
} from "./boundary/host-callback.ts";
import { makePiExec } from "./boundary/host-exec.ts";
import { makeWorkingMessageHost } from "./boundary/host-working-message.ts";
import { CosmicUiConfigStore } from "./config/store.ts";
import type { FooterTotals } from "./footer/component.ts";
import { FooterRegistryService, type FooterRegistryBridge } from "./footer/registry.ts";
import { CosmicUiService, type CosmicUiProjection } from "./protocol/service.ts";
import { makeFooterProtocolHostLayer, type FooterProtocolBuffer } from "./protocol/host.ts";
import { WorkingTimerService } from "./working/service.ts";
import { ActivityService, type ActivityServiceContract } from "./activity/service.ts";
import type { ActivityHost } from "./boundary/host-activity.ts";

/** Plain session values captured by the Pi adapter before runtime construction. */
export interface CosmicUiSessionInput {
  readonly ctx: ExtensionContext;
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly cwd: string;
  readonly signal: AbortSignal | undefined;
  readonly releaseSignal: () => void;
  readonly initialTotals: FooterTotals;
  readonly projectTrusted: boolean;
}

export interface CosmicUiApplicationLayerOptions {
  readonly callbacks: HostCallbackBoundaryContract;
  readonly bridge: FooterRegistryBridge;
  readonly projection: MutableRef.MutableRef<CosmicUiProjection>;
  readonly protocolBuffer: FooterProtocolBuffer;
  readonly requestRender: () => void;
  readonly activityHost?: ActivityHost;
}

/** Compose the complete Cosmic UI dependency graph for one Pi session. */
export const makeCosmicUiApplicationLayer = (
  { context, cwd, initialTotals, projectTrusted }: CosmicUiSessionInput,
  options: CosmicUiApplicationLayerOptions,
) => {
  const callbackBoundary = HostCallbackBoundary.layer(options.callbacks);
  const platform = Layer.merge(
    nodeFilePlatformLayer,
    AgentDirectory.layerFromHost(() => getAgentDir()),
  );
  const configStore = CosmicUiConfigStore.layer.pipe(Layer.provide(platform));
  const service = Layer.effect(
    CosmicUiService,
    Effect.gen(function* () {
      const pi = yield* PiApi;
      return yield* CosmicUiService.make({
        context,
        cwd,
        exec: makePiExec(pi.exec),
        initialTotals,
        projection: options.projection,
        projectTrusted,
        onChange: options.requestRender,
      });
    }),
  ).pipe(Layer.provide(Layer.merge(configStore, callbackBoundary)));
  const registry = FooterRegistryService.layer({ bridge: options.bridge }).pipe(
    Layer.provide(callbackBoundary),
  );
  const protocol = makeFooterProtocolHostLayer({ buffer: options.protocolBuffer }).pipe(
    Layer.provideMerge(registry),
  );
  const workingMessageHost = makeWorkingMessageHost({
    context,
    callbacks: options.callbacks,
  });
  const workingTimer = WorkingTimerService.layer(workingMessageHost);
  const activity = Layer.effect(
    ActivityService,
    Effect.suspend(() => {
      let connected: ActivityServiceContract | undefined;
      return ActivityService.make({
        publish: (rows, starting) => {
          if (connected) options.activityHost?.publish(connected, rows, starting);
        },
        tick: (now) => {
          if (connected) options.activityHost?.tick(connected, now);
        },
        connect: (value) => {
          connected = value;
          return options.activityHost?.bind(value) ?? (() => undefined);
        },
      });
    }),
  );
  return Layer.mergeAll(service, protocol, workingTimer, activity);
};

export type CosmicUiApplicationLayer = ReturnType<typeof makeCosmicUiApplicationLayer>;
export type CosmicUiApplication = Layer.Success<CosmicUiApplicationLayer>;
export type CosmicUiRuntimeError = Layer.Error<CosmicUiApplicationLayer>;
