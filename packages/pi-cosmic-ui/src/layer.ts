import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import { AgentDirectory, nodePlatformLayer } from "pi-cosmic-core";
import { HostCallbackBoundary, type HostCallbackBoundaryShape } from "./boundary/host-callback.ts";
import { CosmicUiConfigRepository } from "./config/repository.ts";
import type { FooterTotals } from "./footer/component.ts";
import { FooterRegistryService, type FooterRegistryBridge } from "./footer/registry.ts";
import { CosmicUiService, type CosmicUiProjection } from "./host-service.ts";
import { PiExec } from "./probe/pi-exec.ts";
import { RepositoryProbe } from "./probe/repository-probe.ts";
import { FooterProtocolHost, type FooterProtocolBuffer } from "./protocol-host.ts";

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
  readonly callbacks: HostCallbackBoundaryShape;
  readonly bridge: FooterRegistryBridge;
  readonly projection: MutableRef.MutableRef<CosmicUiProjection>;
  readonly protocolBuffer: FooterProtocolBuffer;
  readonly requestRender: () => void;
}

/** Compose the complete Cosmic UI dependency graph for one Pi session. */
export const makeCosmicUiApplicationLayer = (
  { context, cwd, initialTotals, projectTrusted }: CosmicUiSessionInput,
  options: CosmicUiApplicationLayerOptions,
) => {
  const callbackBoundary = HostCallbackBoundary.layer(options.callbacks);
  const platform = Layer.merge(
    nodePlatformLayer,
    AgentDirectory.layerFromHost(() => getAgentDir()),
  );
  const configRepository = CosmicUiConfigRepository.layer.pipe(Layer.provide(platform));
  const probe = RepositoryProbe.layer.pipe(Layer.provide(PiExec.layer));
  const service = CosmicUiService.layer({
    context,
    cwd,
    initialTotals,
    projection: options.projection,
    projectTrusted,
    onChange: options.requestRender,
  }).pipe(Layer.provide(Layer.mergeAll(configRepository, probe, callbackBoundary)));
  const registry = FooterRegistryService.layer({
    bridge: options.bridge,
    publish: (snapshot) => {
      options.bridge.snapshot = snapshot;
    },
  }).pipe(Layer.provide(callbackBoundary));
  const protocol = FooterProtocolHost.layer({ buffer: options.protocolBuffer }).pipe(
    Layer.provideMerge(registry),
  );
  return Layer.merge(service, protocol);
};

export type CosmicUiApplicationLayer = ReturnType<typeof makeCosmicUiApplicationLayer>;
export type CosmicUiApplication = Layer.Success<CosmicUiApplicationLayer>;
export type CosmicUiRuntimeError = Layer.Error<CosmicUiApplicationLayer>;
