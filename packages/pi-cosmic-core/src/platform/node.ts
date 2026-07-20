import * as Layer from "effect/Layer";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodePath from "@effect/platform-node/NodePath";
import { JsonDocumentStore } from "./json-document.ts";
import { JsonHttpClient } from "./json-http.ts";
import { StreamingHttpClient } from "./streaming-http.ts";

const fileSystemAndPath = Layer.merge(NodeFileSystem.layer, NodePath.layer);
const documents = JsonDocumentStore.layer.pipe(Layer.provideMerge(fileSystemAndPath));
const httpClient = NodeHttpClient.layerUndici;
const http = JsonHttpClient.layer.pipe(Layer.provideMerge(httpClient));
const streamingHttp = StreamingHttpClient.layer.pipe(Layer.provideMerge(httpClient));

/** Filesystem, path, and atomic JSON-document services without networking capabilities. */
export const fileLayer = documents;

/** Node platform services used by network-capable cosmic-pi extensions. */
export const layer = Layer.mergeAll(fileLayer, http, streamingHttp);
