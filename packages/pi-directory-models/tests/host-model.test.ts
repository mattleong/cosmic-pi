import { describe, expect, it } from "vitest";
import { captureSelectedModel, captureThinkingLevel } from "../src/boundary/host-model.ts";

describe("directory model host capture", () => {
  it("accepts bounded model fields while ignoring unrelated host metadata", () => {
    expect(
      captureSelectedModel({ provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true }),
    ).toEqual({ provider: "openai-codex", id: "gpt-5.6-sol" });
  });

  it("rejects malformed fields and contains hostile getters", () => {
    expect(captureSelectedModel({ provider: 42, id: "model" })).toBeUndefined();
    const hostile = Object.defineProperty({}, "provider", {
      enumerable: true,
      get() {
        throw new Error("host getter failed");
      },
    });
    expect(() => captureSelectedModel(hostile)).not.toThrow();
    expect(captureSelectedModel(hostile)).toBeUndefined();
    expect(captureThinkingLevel("unsupported")).toBeUndefined();
  });
});
