import * as Layer from "effect/Layer";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodePath from "@effect/platform-node/NodePath";
import { JsonDocumentStore } from "./json-document.ts";
import { JsonHttpClient } from "./json-http.ts";

const fileSystemAndPath = Layer.merge(NodeFileSystem.layer, NodePath.layer);
const documents = JsonDocumentStore.layer.pipe(Layer.provideMerge(fileSystemAndPath));
const http = JsonHttpClient.layer.pipe(Layer.provideMerge(NodeHttpClient.layerUndici));

/** Narrow Node services used by cosmic-pi extensions. */
export const layer = Layer.merge(documents, http);
