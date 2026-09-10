/** One dependency graph per Pi session. No factory-time transports or nested runtimes. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import { AgentDirectory, nodeFilePlatformLayer } from "pi-cosmic-core";
import { McpAuth } from "./auth/service.ts";
import { JsonSchemaValidator } from "./boundary/schema-validator.ts";
import { McpConnector } from "./boundary/sdk-connection.ts";
import { McpConfigStore } from "./config/store.ts";
import { McpConnections } from "./connection/service.ts";
import { McpDiscovery } from "./discovery/service.ts";
import { McpResults } from "./results/service.ts";
import { McpExecution } from "./tools/service.ts";

export interface McpLayerInput {
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly isTrusted: () => boolean;
}
export const makeMcpLayer = (input: McpLayerInput) => {
  const platform = Layer.mergeAll(
    nodeFilePlatformLayer,
    NodeCrypto.layer,
    AgentDirectory.layerFromHost(getAgentDir),
  );
  const config = McpConfigStore.layer(input).pipe(Layer.provide(platform));
  const auth = McpAuth.layer();
  const connections = McpConnections.layer({ isTrusted: input.isTrusted }).pipe(
    Layer.provide(Layer.mergeAll(config, auth, McpConnector.layer)),
  );
  const discovery = McpDiscovery.layer.pipe(Layer.provide(connections));
  const dependencies = Layer.mergeAll(
    connections,
    discovery,
    McpResults.layer(),
    JsonSchemaValidator.layer(),
    auth,
  );
  const execution = McpExecution.layer.pipe(Layer.provide(dependencies));
  return Layer.mergeAll(execution, config, auth);
};
export type McpApplication = Layer.Success<ReturnType<typeof makeMcpLayer>>;
export type McpRuntimeError = Layer.Error<ReturnType<typeof makeMcpLayer>>;
