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
import { CosmicUiConfigStore } from "./config/store.ts";
import type { FooterTotals } from "./footer/builtin-contributions.ts";
import { CosmicUiService, type CosmicUiProjection } from "./protocol/service.ts";
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
  readonly publicationOwner: MutableRef.MutableRef<boolean>;
}

export interface CosmicUiApplicationLayerOptions {
  readonly callbacks: HostCallbackBoundaryContract;
  readonly projection: MutableRef.MutableRef<CosmicUiProjection>;
  readonly requestRender: () => void;
  readonly activityHost?: ActivityHost;
}

/** Compose the complete Cosmic UI dependency graph for one Pi session. */
export const makeCosmicUiApplicationLayer = (
  { context, cwd, initialTotals, projectTrusted, publicationOwner }: CosmicUiSessionInput,
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
        canPublish: () => MutableRef.get(publicationOwner),
      });
    }),
  ).pipe(Layer.provide(Layer.merge(configStore, callbackBoundary)));
  let connected: ActivityServiceContract | undefined;
  const activity = ActivityService.layer({
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
  return Layer.mergeAll(service, activity);
};

export type CosmicUiApplicationLayer = ReturnType<typeof makeCosmicUiApplicationLayer>;
export type CosmicUiApplication = Layer.Success<CosmicUiApplicationLayer>;
export type CosmicUiRuntimeError = Layer.Error<CosmicUiApplicationLayer>;
