import { Buffer } from "node:buffer";
import { expect, it } from "@effect/vitest";
import type * as Schema from "effect/Schema";
import { measureBoundedJson, snapshotBoundedJson } from "../../src/validation/schema-policy.ts";

const limits = { bytes: 4 * 1024 * 1024, depth: 64, nodes: 100_000 };

it("charges exact compact-JSON UTF-8 bytes and bounds depth and nodes inclusively", () => {
  const values: ReadonlyArray<Schema.Json> = [
    'é😀"\\\n\u0000\u007f\ud800x',
    [1, [true, null, {}, ""]],
    { "k\u0001": ["a", { b: -1.5e-7 }] },
  ];
  for (const value of values) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    expect(snapshotBoundedJson(value, { ...limits, bytes })).toEqual(value);
    expect(() => measureBoundedJson(value, { ...limits, bytes: bytes - 1 })).toThrow();
  }
  expect(measureBoundedJson("🙂".repeat(500_000), limits).bytes).toBe(2_000_002);
  expect(measureBoundedJson("\u0000", limits).bytes).toBe(8);
  const nested = [[null]];
  expect(measureBoundedJson(nested, { ...limits, depth: 2, nodes: 3 })).toEqual({
    bytes: 8,
    nodes: 3,
  });
  expect(() => measureBoundedJson(nested, { ...limits, depth: 1 })).toThrow();
  expect(() => measureBoundedJson(nested, { ...limits, nodes: 2 })).toThrow();
});

it("accepts shared references under limits objects but not at strict ingress", () => {
  const shared = { list: [1] };
  const dag = [shared, { shared }];
  expect(measureBoundedJson(dag, limits).bytes).toBe(Buffer.byteLength(JSON.stringify(dag)));
  expect(snapshotBoundedJson(dag, limits)).toEqual(dag);
  expect(() => snapshotBoundedJson(dag, limits.bytes)).toThrow();
  const cyclic: Record<string, Schema.Json> = {};
  cyclic.self = cyclic;
  expect(() => measureBoundedJson(cyclic, limits)).toThrow();
});

it("measures only own data descriptors of plain values", () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, "secret", { enumerable: true, get: () => ++reads });
  for (const value of [accessor, new Map(), Object.assign([1], { extra: 2 }), [undefined]])
    expect(() => measureBoundedJson(value, limits)).toThrow();
  expect(reads).toBe(0);
});
