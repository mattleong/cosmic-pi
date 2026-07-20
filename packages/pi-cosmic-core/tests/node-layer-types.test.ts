import type * as HttpClient from "effect/unstable/http/HttpClient";
import type * as Layer from "effect/Layer";
import { describe, expectTypeOf, it } from "vitest";
import { JsonHttpClient, nodePlatformLayer, StreamingHttpClient } from "../index.ts";

type NodePlatform = Layer.Success<typeof nodePlatformLayer>;

describe("node platform layer type", () => {
  it("exports workspace HTTP adapters without leaking the unstable client", () => {
    expectTypeOf<JsonHttpClient>().toExtend<NodePlatform>();
    expectTypeOf<StreamingHttpClient>().toExtend<NodePlatform>();
    expectTypeOf<HttpClient.HttpClient>().not.toExtend<NodePlatform>();
  });
});
