import { describe, expect, it } from "vitest";
import { toolSchemaPortabilityProblems } from "../testing.ts";

describe("tool schema portability", () => {
  it("reports nonportable keywords wherever they are nested", () => {
    expect(
      toolSchemaPortabilityProblems({
        type: "object",
        properties: {
          text: { type: "string", pattern: ".*\\S.*" },
          list: { type: "array", items: { type: "string", deprecated: true } },
          choice: { type: "string", anyOf: [{ const: "a" }, { const: "b" }] },
          extra: { type: "object", additionalProperties: { allOf: [{ type: "string" }] } },
        },
      }),
    ).toEqual([
      "#.properties.text: pattern",
      "#.properties.list.items: deprecated",
      "#.properties.choice: type with anyOf or oneOf",
      "#.properties.choice.anyOf[0]: const",
      "#.properties.choice.anyOf[1]: const",
      "#.properties.extra.additionalProperties: allOf",
    ]);
  });
});
