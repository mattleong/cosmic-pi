import * as Layer from "effect/Layer";
import { AgentDirectory, nodeFilePlatformLayer } from "pi-cosmic-core";
import { HerdrClient } from "./boundary/herdr-client.ts";
import { ReportChannel } from "./boundary/report-channel.ts";
import { HerdrConfigStore } from "./config/store.ts";
import type { HerdrProjection } from "./herd/model.ts";
import { HerdrService } from "./herd/service.ts";

export interface HerdrSessionInput {
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly agentDirectory: string;
}

export interface HerdrLayerOptions {
  readonly publish: (projection: HerdrProjection) => void;
}

export const makeHerdrLayer = (input: HerdrSessionInput, options: HerdrLayerOptions) => {
  const platform = Layer.merge(nodeFilePlatformLayer, AgentDirectory.layer(input.agentDirectory));
  const config = HerdrConfigStore.layer({
    cwd: input.cwd,
    projectTrusted: input.projectTrusted,
  }).pipe(Layer.provide(platform));
  const client = HerdrClient.layer().pipe(Layer.provide(config));
  const reports = ReportChannel.layer.pipe(Layer.provide(platform));
  const dependencies = Layer.mergeAll(platform, config, client, reports);
  const service = HerdrService.layer({ cwd: input.cwd, publish: options.publish }).pipe(
    Layer.provide(dependencies),
  );
  return Layer.merge(service, config);
};

export type HerdrApplicationLayer = ReturnType<typeof makeHerdrLayer>;
export type HerdrApplication = Layer.Success<HerdrApplicationLayer>;
export type HerdrRuntimeError = Layer.Error<HerdrApplicationLayer>;
