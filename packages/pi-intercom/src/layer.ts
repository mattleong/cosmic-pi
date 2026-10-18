import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import { AgentDirectory, nodeFilePlatformLayer } from "pi-cosmic-core";
import { IntercomRegistry, type IntercomRegistryOptions } from "./registry/store.ts";
import { IntercomSession, type IntercomSessionInput } from "./session/service.ts";
import { IntercomInbound, type IntercomInboundContract } from "./transport/server.ts";

export const intercomLayer = (
  input: IntercomSessionInput,
  inbound: IntercomInboundContract,
  options: IntercomRegistryOptions,
) => {
  const platform = Layer.merge(nodeFilePlatformLayer, AgentDirectory.layerFromHost(getAgentDir));
  const registry = IntercomRegistry.layer(options).pipe(Layer.provide(platform));
  return IntercomSession.layer(input).pipe(
    Layer.provideMerge(registry),
    Layer.provide(Layer.merge(platform, Layer.succeed(IntercomInbound, inbound))),
  );
};
