import { describe, expect, it } from "vitest";
import { HerdrStartParameters } from "../src/tools/schema.ts";

describe("Herdr tool schemas", () => {
  it("validates model names without provider-incompatible regex lookaround", () => {
    const modelSchema = HerdrStartParameters.properties.agents.items.properties.model as {
      readonly pattern?: string;
    };
    expect(modelSchema.pattern).toBeTypeOf("string");
    if (!modelSchema.pattern) return;
    expect(modelSchema.pattern).not.toMatch(/\(\?(?:[=!]|<[=!])/);

    const pattern = new RegExp(modelSchema.pattern);
    expect(pattern.test("sonnet")).toBe(true);
    expect(pattern.test("openai-codex/gpt-5.6-sol")).toBe(true);
    expect(pattern.test("-sonnet")).toBe(false);
    expect(pattern.test("gpt\n5")).toBe(false);
    expect(pattern.test("gpt\u007f5")).toBe(false);
  });
});
