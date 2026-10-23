import { describe, expect, it } from "@effect/vitest";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Str from "effect/String";
import { boundedNdjsonRpcSerialization } from "../src/platform/bounded-ndjson-rpc.ts";

describe("bounded NDJSON RPC framing", () => {
  it("fails closed on malformed frames, including frames between valid messages", () => {
    for (const frame of ["invalid\n", '{"x":1}\ninvalid\n{"x":2}\n']) {
      const parser = boundedNdjsonRpcSerialization(64).makeUnsafe();
      expect(() => parser.decode(frame)).toThrow();
    }
  });

  it("retains split UTF-8 and JSON only within the owning parser", () => {
    const serialization = boundedNdjsonRpcSerialization(64);
    const first = serialization.makeUnsafe();
    const second = serialization.makeUnsafe();
    const value = { text: "🌌" };
    const encoded = first.encode(value);
    if (!Predicate.isString(encoded)) throw new Error("Expected a text frame.");
    const bytes = new TextEncoder().encode(encoded);
    expect(first.decode(bytes.subarray(0, 11))).toEqual([]);
    expect(second.decode(second.encode({ other: true })!)).toEqual([{ other: true }]);
    expect(first.decode(bytes.subarray(11))).toEqual([value]);
  });

  it("rejects oversized frames, both completed and incomplete", () => {
    for (const frame of [
      Fn.pipe("x", Str.repeat(9)),
      `"${Fn.pipe("x", Str.repeat(9))}"\n`,
      "🌌🌌🌌",
    ]) {
      const parser = boundedNdjsonRpcSerialization(8).makeUnsafe();
      expect(() => parser.decode(frame)).toThrow(RpcSerialization.MaxBufferSizeExceeded);
    }
    const parser = boundedNdjsonRpcSerialization(8).makeUnsafe();
    expect(parser.decode("12345")).toEqual([]);
    expect(() => parser.decode("6789")).toThrow();
  });

  it("bounds a frame buffered across chunks by its UTF-8 bytes, joining split surrogate pairs", () => {
    const chunks = ['"\ud83c', '\udf0c"'];
    const completed = boundedNdjsonRpcSerialization(6).makeUnsafe();
    for (const chunk of chunks) expect(completed.decode(chunk)).toEqual([]);
    expect(completed.decode("\n")).toEqual(["🌌"]);
    const overflowing = boundedNdjsonRpcSerialization(6).makeUnsafe();
    for (const chunk of chunks) expect(overflowing.decode(chunk)).toEqual([]);
    expect(() => overflowing.decode("x")).toThrow(RpcSerialization.MaxBufferSizeExceeded);
  });
});
