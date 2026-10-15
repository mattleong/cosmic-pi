import { describe, expect, it } from "vitest";
import { jsonPrefixScalars } from "../src/boundary/json-prefix.ts";

describe("truncated JSON leaf reading", () => {
  it("reports nested leaves before the cut and none that the cut splits", () => {
    const text =
      '{"type":"user","n":1.5e3,"ok":true,"message":{"role":"user","content":[{"id":"a\\"b","type":"tool_result","content":"partial';
    expect(Object.fromEntries(jsonPrefixScalars(text))).toEqual({
      type: "user",
      ok: true,
      "message.role": "user",
      "message.content.0.id": 'a"b',
      "message.content.0.type": "tool_result",
    });
  });

  it("continues past closed containers and stops at invalid input", () => {
    expect(
      Object.fromEntries(jsonPrefixScalars('{"a":{"b":[1,{"c":false}]},"d":"e","f":tru')),
    ).toEqual({ "a.b.1.c": false, d: "e" });
    expect(jsonPrefixScalars('{"a":"b" "c":"d"}')).toEqual(new Map([["a", "b"]]));
  });
});
