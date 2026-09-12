import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import type * as Schema from "effect/Schema";
import {
  encodeMcpHeaderValue,
  MCP_PARAMETER_HEADER_LIMITS,
  parameterHeaders,
  scanParameterHeaders,
} from "../../src/invocation/parameter-headers.ts";

const annotated = (type = "string", name: Schema.Json = "Region"): Schema.JsonObject => ({
  type,
  "x-mcp-header": name,
});
const schema = (property: Schema.Json): Schema.JsonObject => ({
  type: "object",
  properties: { region: property },
});

it.each([
  ["simple", "simple"],
  ["", ""],
  ["a b\tc", "a b\tc"],
  [" padded ", "=?base64?IHBhZGRlZCA=?="],
  ["\t", "=?base64?CQ==?="],
  ["line1\nline2", "=?base64?bGluZTEKbGluZTI=?="],
  ["\r\n\u0000\u007f", "=?base64?DQoAfw==?="],
  ["Hello, 世界", "=?base64?SGVsbG8sIOS4lueVjA==?="],
  ["=?base64?literal?=", "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?="],
  ["=?BASE64?literal?=", "=?BASE64?literal?="],
  ["=?base64?unfinished", "=?base64?unfinished"],
])("encodes header values without HTTP whitespace or sentinel ambiguity: %j", (value, expected) => {
  expect(encodeMcpHeaderValue(value)).toBe(expected);
});

it.each([
  "\ud800",
  "\udfff",
  "\ud800x",
  "\ud800\ud800",
  "\udc00\ud800",
  "é\ud800",
  "\ud800\udc00\udfff",
])("rejects malformed UTF-16 before header conversion: %j", (value) => {
  for (const encode of [
    () => encodeMcpHeaderValue(`private-value-${value}`),
    () => parameterHeaders(schema(annotated()), { region: `private-value-${value}` }),
  ]) {
    expect(encode).toThrowError(
      expect.objectContaining({ kind: "invalid-input", outcome: "not-sent" }),
    );
    try {
      encode();
    } catch (error) {
      expect(String(error)).not.toContain("private-value");
    }
  }
});

it.each(["\ud800\udc00", "\udbff\udfff", "prefix😀suffix", "😀𐀀"])(
  "preserves valid surrogate pairs in encoded headers: %j",
  (value) => {
    const encoded = encodeMcpHeaderValue(value);
    expect(encoded.startsWith("=?base64?")).toBe(true);
    expect(Buffer.from(encoded.slice(9, -2), "base64").toString("utf8")).toBe(value);
    expect(parameterHeaders(schema(annotated()), { region: value })["Mcp-Param-Region"]).toBe(
      encoded,
    );
  },
);

it.each(["", "has space", "bad:colon", "bad\r\nInjected", "é", null, 3])(
  "rejects invalid annotation names without leaking values: %j",
  (name) => {
    expect(scanParameterHeaders(schema(annotated("string", name))).valid).toBe(false);
  },
);
it.each(["number", "object", "array", "null", ["string", "null"]])(
  "rejects unsupported and union primitive types: %j",
  (type) => {
    expect(scanParameterHeaders(schema({ type, "x-mcp-header": "Region" })).valid).toBe(false);
  },
);
it.each([
  { "x-mcp-header": "Root", type: "string" },
  { $defs: { choice: annotated() }, $ref: "#/$defs/choice" },
  schema({ items: annotated(), type: "array" }),
  schema({ prefixItems: [annotated()], type: "array" }),
  ...["oneOf", "anyOf", "allOf"].map((key) => ({ [key]: [schema(annotated())] })),
  ...["not", "if", "then", "else", "additionalProperties"].map((key) => ({
    [key]: schema(annotated()),
  })),
])("rejects annotations outside properties-only paths: %j", (invalid) => {
  expect(scanParameterHeaders(invalid).valid).toBe(false);
});
it.each(["const", "default", "examples", "enum", "x-example"])(
  "does not interpret literal data under %s as header annotations",
  (keyword) => {
    const literal = {
      "x-mcp-header": "literal data",
      properties: { nested: annotated("number", "NotAnAnnotation") },
    };
    const input = {
      properties: {
        region: annotated(),
        payload: {
          type: "object",
          [keyword]: keyword === "examples" || keyword === "enum" ? [literal] : literal,
        },
      },
    };
    expect(scanParameterHeaders(input).valid).toBe(true);
    expect(parameterHeaders(input, { region: "north", payload: literal })).toEqual({
      "Mcp-Param-Region": "north",
    });
  },
);
it.each(["$defs", "definitions", "patternProperties", "dependentSchemas", "dependencies"])(
  "rejects annotations in schema maps without interpreting map keys: %s",
  (keyword) => {
    expect(scanParameterHeaders({ [keyword]: { "x-mcp-header": { type: "string" } } }).valid).toBe(
      true,
    );
    expect(scanParameterHeaders({ [keyword]: { "x-mcp-header": annotated() } }).valid).toBe(false);
  },
);
it("retains structural limits inside literal schema data", () => {
  let literal: Schema.Json = {};
  for (let index = 0; index < 70; index++) literal = { child: literal };
  expect(scanParameterHeaders(schema({ default: literal })).valid).toBe(false);
});
it("counts schema containers, property entries, and literal data in the node budget", () => {
  // Root, default array, properties map, payload schema, and allOf array use five nodes.
  const literal: Array<Schema.Json> = Array.from(
    { length: MCP_PARAMETER_HEADER_LIMITS.schemaNodes - 5 },
    () => null,
  );
  const input = { default: literal, properties: { payload: {} }, allOf: [] };
  expect(scanParameterHeaders(input).valid).toBe(true);
  literal.push(null);
  expect(scanParameterHeaders(input).valid).toBe(false);
});
it.each([{ allOf: [] }, { properties: {} }])(
  "counts empty schema containers at the depth boundary: %j",
  (container) => {
    let input: Schema.Json = container;
    for (let index = 1; index < MCP_PARAMETER_HEADER_LIMITS.schemaDepth; index++)
      input = { not: input };
    expect(scanParameterHeaders(input).valid).toBe(true);
    expect(scanParameterHeaders({ not: input }).valid).toBe(false);
  },
);
it("rejects duplicate names ignoring case, including nested paths", () => {
  expect(
    scanParameterHeaders({
      properties: {
        first: annotated("string", "Region"),
        nested: schema(annotated("string", "REGION")),
      },
    }).valid,
  ).toBe(false);
});
it("extracts exact nested own-property paths and all supported primitives", () => {
  const input = {
    properties: {
      region: annotated(),
      nested: {
        properties: {
          active: annotated("boolean", "Active"),
          count: annotated("integer", "Count"),
          "x-mcp-header": annotated("string", "LiteralProperty"),
        },
      },
    },
  };
  expect(
    parameterHeaders(input, {
      region: "north",
      nested: { active: false, count: -42, "x-mcp-header": "literal" },
    }),
  ).toEqual({
    "Mcp-Param-Region": "north",
    "Mcp-Param-Active": "false",
    "Mcp-Param-Count": "-42",
    "Mcp-Param-LiteralProperty": "literal",
  });
  for (const args of [{}, { region: null }, { nested: null }, { nested: {} }])
    expect(parameterHeaders(input, args)).toEqual({});
  expect(
    parameterHeaders(schema(annotated("integer")), { region: Number.MAX_SAFE_INTEGER }),
  ).toEqual({ "Mcp-Param-Region": String(Number.MAX_SAFE_INTEGER) });
});
it("defends nested input and safe-integer conversion even if a validator seam accepts it", () => {
  for (const args of [{ nested: 1 }, { nested: [] }, { nested: "wrong" }])
    expect(() =>
      parameterHeaders(schema(schema(annotated())), { region: args.nested }),
    ).toThrowError(expect.objectContaining({ kind: "invalid-input", outcome: "not-sent" }));
  for (const value of [1.1, Number.MAX_SAFE_INTEGER + 1, "1", true])
    expect(() => parameterHeaders(schema(annotated("integer")), { region: value })).toThrow();
  expect(() => parameterHeaders(schema(annotated("boolean")), { region: "false" })).toThrow();
  expect(() => parameterHeaders(schema(annotated()), { region: 42 })).toThrow();
});
it("bounds scanning, header count, and aggregate encoded bytes", () => {
  const properties = Object.fromEntries(
    Array.from({ length: MCP_PARAMETER_HEADER_LIMITS.count + 1 }, (_, index) => [
      `p${index}`,
      annotated("string", `H${index}`),
    ]),
  );
  expect(scanParameterHeaders({ properties }).valid).toBe(false);
  let deep: Schema.Json = annotated();
  for (let index = 0; index < 70; index++) deep = schema(deep);
  expect(scanParameterHeaders(deep).valid).toBe(false);
  expect(scanParameterHeaders(schema(annotated("string", "H".repeat(20_000)))).valid).toBe(false);
  const pair = { properties: { one: annotated("string", "One"), two: annotated("string", "Two") } };
  const sensitive = "私".repeat(3_000);
  expect(() => parameterHeaders(pair, { one: sensitive, two: sensitive })).toThrowError(
    expect.objectContaining({ kind: "invalid-input", outcome: "not-sent" }),
  );
  try {
    parameterHeaders(pair, { one: sensitive, two: sensitive });
  } catch (error) {
    expect(String(error)).not.toContain(sensitive);
  }
});
