import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import { AgentDirectory } from "pi-cosmic-core/platform/agent-directory";
import { nodeFilePlatformLayer } from "pi-cosmic-core/platform/node-file";
import { PiExec } from "./boundary/host-exec.ts";
import type { FooterTotals } from "./boundary/host-usage.ts";
import { CosmicUiConfigStore } from "./config/store.ts";
import { RepositoryProbe } from "./probe/repository-probe.ts";
import { CosmicUiService, type CosmicUiProjection } from "./protocol/service.ts";
import { ActivityService } from "./activity/service.ts";
import type { ActivityHost } from "./boundary/host-activity.ts";

export interface CosmicUiSessionInput {
  readonly ctx: ExtensionContext;
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  /** The originating session; later contexts must carry it to update or reconcile this session. */
  readonly sessionManager: ExtensionContext["sessionManager"];
  readonly cwd: string;
  readonly signal: AbortSignal | undefined;
  readonly releaseSignal: () => void;
  readonly initialTotals: FooterTotals;
  readonly readUsageTotals: () => FooterTotals | undefined;
  readonly projectTrusted: boolean;
  readonly publicationOwner: MutableRef.MutableRef<boolean>;
}

export interface CosmicUiApplicationLayerOptions {
  readonly projection: MutableRef.MutableRef<CosmicUiProjection>;
  readonly requestRender: () => void;
  readonly invalidateContextUsage: () => void;
  readonly activityHost: ActivityHost;
}

export const cosmicUiApplicationLayer = (
  {
    ctx,
    context,
    sessionManager,
    cwd,
    initialTotals,
    readUsageTotals,
    projectTrusted,
    publicationOwner,
  }: CosmicUiSessionInput,
  options: CosmicUiApplicationLayerOptions,
) => {
  const platform = Layer.merge(nodeFilePlatformLayer, AgentDirectory.layerFromHost(getAgentDir));
  const service = CosmicUiService.layer({
    context,
    sessionManager,
    cwd,
    initialTotals,
    readUsageTotals,
    projection: options.projection,
    projectTrusted,
    onChange: options.requestRender,
    onUsageChange: options.invalidateContextUsage,
    canPublish: () => MutableRef.get(publicationOwner),
  }).pipe(
    Layer.provide(
      Layer.merge(
        CosmicUiConfigStore.layer.pipe(Layer.provide(platform)),
        RepositoryProbe.layer.pipe(Layer.provide(PiExec.layer)),
      ),
    ),
  );
  // Headless sessions retain preferences, but acquire no Activity host binding or clock.
  return Layer.merge(
    service,
    ActivityService.layer(
      ctx.mode === "tui" ? options.activityHost.serviceOptions() : { publish: () => undefined },
    ),
  );
};

type CosmicUiApplicationLayer = ReturnType<typeof cosmicUiApplicationLayer>;
export type CosmicUiApplication = Layer.Success<CosmicUiApplicationLayer>;
export type CosmicUiRuntimeError = Layer.Error<CosmicUiApplicationLayer>;
