import * as Schema from "effect/Schema";
import { describe, expectTypeOf, it } from "vitest";
import type { JsonHttpClientContract, JsonHttpRequestInput, JsonHttpResponse } from "../index.ts";

const acceptsOnlyConcreteResponseSchemas = (http: JsonHttpClientContract) => {
  const concrete = http.request({
    url: "https://example.invalid",
    responseSchema: Schema.Struct({ ok: Schema.Boolean }),
  });
  expectTypeOf(concrete).toExtend<
    import("effect/Effect").Effect<JsonHttpResponse<{ readonly ok: boolean }>, unknown, unknown>
  >();

  const unknownResponse = http.request({
    url: "https://example.invalid",
    // @ts-expect-error Top-level unknown is not a decoded response contract.
    responseSchema: Schema.Unknown,
  });
  const anyResponse = http.request({
    url: "https://example.invalid",
    // @ts-expect-error Top-level any is not a decoded response contract.
    responseSchema: Schema.Any,
  });
  void unknownResponse;
  void anyResponse;
};

const acceptsOnlyJsonEncodedRequestSchemas = (
  http: import("../index.ts").StreamingHttpClientContract,
) => {
  const concrete = http.requestJsonRawBytes(
    { url: "https://example.invalid", method: "POST" },
    Schema.Struct({ prompt: Schema.String }),
    { prompt: "hello" },
  );

  const undefinedBody = http.requestJsonRawBytes(
    { url: "https://example.invalid", method: "POST" },
    // @ts-expect-error Undefined is not a JSON-encoded request body.
    Schema.Undefined,
    undefined,
  );
  void concrete;
  void undefinedBody;
};

describe("HTTP platform public types", () => {
  it("exclude unknown responses and non-JSON request encodings", () => {
    expectTypeOf<JsonHttpRequestInput<unknown, never>["responseSchema"]>().toEqualTypeOf<never>();
    expectTypeOf(acceptsOnlyConcreteResponseSchemas).toBeFunction();
    expectTypeOf(acceptsOnlyJsonEncodedRequestSchemas).toBeFunction();
  });
});
