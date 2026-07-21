import * as Layer from "effect/Layer";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodePath from "@effect/platform-node/NodePath";
import { JsonDocumentStore } from "./json-document.ts";
import { JsonHttpClient } from "./json-http.ts";
import { ProcessCoordinator } from "./process-coordinator.ts";
import { StreamingHttpClient } from "./streaming-http.ts";

const fileDependencies = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  ProcessCoordinator.layer,
);
const documents = JsonDocumentStore.layer.pipe(Layer.provideMerge(fileDependencies));
const http = Layer.merge(JsonHttpClient.layer, StreamingHttpClient.layer).pipe(
  Layer.provide(NodeHttpClient.layerUndici),
);

/** Filesystem, path, and atomic JSON-document services without networking capabilities. */
export const fileLayer = documents;

/** Node platform services used by network-capable cosmic-pi extensions. */
export const layer = Layer.merge(fileLayer, http);
