import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { AgentDirectory, JsonDocumentStore, type JsonDocumentStoreContract } from "pi-cosmic-core";
import type { InMemoryDocuments } from "pi-cosmic-core/testing";
import type { McpEffectiveServer, McpResolvedConfig } from "../../src/config/model.ts";
import { McpConfigStore } from "../../src/config/store.ts";

export const GLOBAL = "/agent/extensions/pi-mcp.json";
export const PROJECT = `/project/${CONFIG_DIR_NAME}/extensions/pi-mcp.json`;
export const PROJECT_ROOT = "/project/.mcp.json";
export const serializedConfig = (config: McpResolvedConfig | McpEffectiveServer | undefined) =>
  JSON.stringify(config);
export const parseJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

/** An in-memory config store rooted at `/project`, with global config under `/agent`. */
export const layerFor = (
  memory: InMemoryDocuments,
  projectTrusted = true,
  service: JsonDocumentStoreContract = memory.service,
) =>
  McpConfigStore.layer({ cwd: "/project", projectTrusted }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(JsonDocumentStore, service),
        AgentDirectory.layer("/agent"),
        Path.layer,
        NodeCrypto.layer,
      ),
    ),
  );
