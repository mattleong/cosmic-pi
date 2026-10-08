import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import { AgentDirectory, nodeFilePlatformLayer, PiApi } from "pi-cosmic-core";
import { makePiExec } from "./boundary/host-exec.ts";
import type { FooterTotals } from "./boundary/host-usage.ts";
import { CosmicUiConfigStore } from "./config/store.ts";
import { CosmicUiService, type CosmicUiProjection } from "./protocol/service.ts";
import { ActivityService } from "./activity/service.ts";
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
  readonly projection: MutableRef.MutableRef<CosmicUiProjection>;
  readonly requestRender: () => void;
  readonly activityHost: ActivityHost;
}

/** Compose the complete Cosmic UI dependency graph for one Pi session. */
export const makeCosmicUiApplicationLayer = (
  { context, cwd, initialTotals, projectTrusted, publicationOwner }: CosmicUiSessionInput,
  options: CosmicUiApplicationLayerOptions,
) => {
  const platform = Layer.merge(nodeFilePlatformLayer, AgentDirectory.layerFromHost(getAgentDir));
  const service = Layer.effect(
    CosmicUiService,
    PiApi.use((pi) =>
      CosmicUiService.make({
        context,
        cwd,
        exec: makePiExec(pi.exec),
        initialTotals,
        projection: options.projection,
        projectTrusted,
        onChange: options.requestRender,
        canPublish: () => MutableRef.get(publicationOwner),
      }),
    ),
  ).pipe(Layer.provide(CosmicUiConfigStore.layer.pipe(Layer.provide(platform))));
  return Layer.mergeAll(service, ActivityService.layer(options.activityHost.serviceOptions()));
};

type CosmicUiApplicationLayer = ReturnType<typeof makeCosmicUiApplicationLayer>;
export type CosmicUiApplication = Layer.Success<CosmicUiApplicationLayer>;
export type CosmicUiRuntimeError = Layer.Error<CosmicUiApplicationLayer>;
