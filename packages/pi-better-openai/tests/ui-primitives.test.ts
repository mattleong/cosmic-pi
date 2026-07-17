import { describe, expect, test } from "vitest";
import { fastModeFooterPrimitive, openAIUsageFooterPrimitive } from "../src/ui/primitives.ts";

describe("public footer primitives", () => {
  test("creates a reusable fast-mode contribution from public state", () => {
    expect(
      fastModeFooterPrimitive({
        desired: true,
        active: true,
        supported: true,
        modelId: "gpt-5.5",
      }),
    ).toMatchObject({ id: "openai.fast", text: "fast", tone: "success" });
    expect(
      fastModeFooterPrimitive({
        desired: false,
        active: false,
        supported: true,
      }),
    ).toBeUndefined();
  });

  test("creates a reusable usage contribution from public state", () => {
    expect(openAIUsageFooterPrimitive({ visible: true, text: "Usage: 90%" })).toMatchObject({
      id: "openai.usage",
      text: "Usage: 90%",
      region: "details",
    });
    expect(openAIUsageFooterPrimitive({ visible: false })).toBeUndefined();
  });
});
