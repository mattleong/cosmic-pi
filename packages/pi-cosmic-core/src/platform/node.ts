import * as Layer from "effect/Layer";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { nodeFilePlatformLayer } from "./node-file.ts";
import { JsonHttpClient } from "./json-http.ts";
import { StreamingHttpClient } from "./streaming-http.ts";

const http = Layer.merge(JsonHttpClient.layer, StreamingHttpClient.layer).pipe(
  Layer.provide(NodeHttpClient.layerUndici),
);

export const nodePlatformLayer = Layer.merge(nodeFilePlatformLayer, http);
export { nodeFilePlatformLayer as fileLayer, nodePlatformLayer as layer };
