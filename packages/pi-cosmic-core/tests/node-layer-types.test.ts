import type * as HttpClient from "effect/unstable/http/HttpClient";
import type * as Layer from "effect/Layer";
import { describe, expectTypeOf, it } from "vitest";
import {
  JsonDocumentStore,
  JsonHttpClient,
  nodeFilePlatformLayer,
  nodePlatformLayer,
  ProcessCoordinator,
  StreamingHttpClient,
} from "../index.ts";

type NodeFilePlatform = Layer.Success<typeof nodeFilePlatformLayer>;
type NodePlatform = Layer.Success<typeof nodePlatformLayer>;

describe("node platform layer type", () => {
  it("provides keyed coordination with atomic document storage", () => {
    expectTypeOf<ProcessCoordinator>().toExtend<NodeFilePlatform>();
    expectTypeOf<JsonDocumentStore>().toExtend<NodeFilePlatform>();
  });

  it("exports workspace HTTP adapters without leaking the unstable client", () => {
    expectTypeOf<JsonHttpClient>().toExtend<NodePlatform>();
    expectTypeOf<StreamingHttpClient>().toExtend<NodePlatform>();
    expectTypeOf<HttpClient.HttpClient>().not.toExtend<NodePlatform>();
  });
});
