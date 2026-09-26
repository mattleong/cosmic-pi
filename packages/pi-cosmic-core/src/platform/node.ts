import * as Layer from "effect/Layer";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodePath from "@effect/platform-node/NodePath";
import { JsonDocumentStore } from "./json-document.ts";
import { JsonHttpClient } from "./json-http.ts";
import { StreamingHttpClient } from "./streaming-http.ts";

const http = Layer.merge(JsonHttpClient.layer, StreamingHttpClient.layer).pipe(
  Layer.provide(NodeHttpClient.layerUndici),
);

/** Filesystem, path, and atomic JSON-document services without networking capabilities. */
export const fileLayer = JsonDocumentStore.layer.pipe(
  Layer.provideMerge(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
);

/** Node platform services used by network-capable cosmic-pi extensions. */
export const layer = Layer.merge(fileLayer, http);
