import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import { AgentDirectory, nodeFilePlatformLayer } from "pi-cosmic-core";
import {
  HostCallbackBoundary,
  type HostCallbackBoundaryContract,
} from "./boundary/host-callback.ts";
import { WorkingMessageHost } from "./boundary/host-working-message.ts";
import { CosmicUiConfigStore } from "./config/store.ts";
import type { FooterTotals } from "./footer/component.ts";
import { FooterRegistryService, type FooterRegistryBridge } from "./footer/registry.ts";
import { CosmicUiService, type CosmicUiProjection } from "./protocol/service.ts";
import { PiExec } from "./boundary/host-exec.ts";
import { RepositoryProbe } from "./probe/repository-probe.ts";
import { makeFooterProtocolHostLayer, type FooterProtocolBuffer } from "./protocol/host.ts";
import { WorkingTimerService } from "./working/service.ts";

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
  const probe = RepositoryProbe.layer.pipe(Layer.provide(PiExec.layer));
  const service = CosmicUiService.layer({
    context,
    cwd,
    initialTotals,
    projection: options.projection,
    projectTrusted,
    onChange: options.requestRender,
  }).pipe(Layer.provide(Layer.mergeAll(configStore, probe, callbackBoundary)));
  const registry = FooterRegistryService.layer({ bridge: options.bridge }).pipe(
    Layer.provide(callbackBoundary),
  );
  const protocol = makeFooterProtocolHostLayer({ buffer: options.protocolBuffer }).pipe(
    Layer.provideMerge(registry),
  );
  const workingMessageHost = WorkingMessageHost.layer({ context }).pipe(
    Layer.provide(callbackBoundary),
  );
  const workingTimer = WorkingTimerService.layer.pipe(Layer.provide(workingMessageHost));
  return Layer.mergeAll(service, protocol, workingTimer);
};

export type CosmicUiApplicationLayer = ReturnType<typeof makeCosmicUiApplicationLayer>;
export type CosmicUiApplication = Layer.Success<CosmicUiApplicationLayer>;
export type CosmicUiRuntimeError = Layer.Error<CosmicUiApplicationLayer>;
