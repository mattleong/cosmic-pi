import * as Effect from "effect/Effect";
import { extensionApiFixture, extensionContextFixture, modelFixture } from "pi-cosmic-core/testing";
import { describe, expect, it } from "vitest";
import {
  applyHostPreference,
  captureContextModel,
  captureSelectedModel,
  captureThinkingLevel,
  DirectoryModelHostError,
} from "../src/boundary/host-model.ts";
import { directoryModelPreference } from "../src/config/schema.ts";

describe("directory model host capture", () => {
  it("captures model fields and contains malformed or hostile host values", () => {
    expect(
      captureSelectedModel(
        modelFixture({ provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true }),
      ),
    ).toEqual({ provider: "openai-codex", id: "gpt-5.6-sol" });
    expect(captureSelectedModel({ provider: 42, id: "model" })).toBeUndefined();
    const hostile = Object.defineProperty(modelFixture(), "provider", {
      enumerable: true,
      get() {
        throw new Error("host getter failed");
      },
    });
    expect(captureSelectedModel(hostile)).toBeUndefined();
    expect(captureThinkingLevel("unsupported")).toBeUndefined();
  });

  it("keeps fallback capture total but reports restoration read failures", () => {
    const hostileContext = Object.defineProperty({}, "model", {
      enumerable: true,
      get() {
        throw new Error("host getter failed");
      },
    });
    const ctx = extensionContextFixture(hostileContext);
    expect(captureContextModel(ctx)).toBeUndefined();

    const preference = directoryModelPreference("/project", "openai-codex", "gpt-5.6-sol", "high");
    const pi = extensionApiFixture({});
    const hostileModel = Object.defineProperty(modelFixture({ provider: "openai-codex" }), "id", {
      enumerable: true,
      get() {
        throw new Error("host getter failed");
      },
    });
    const nestedHostile = extensionContextFixture({ model: hostileModel });
    for (const context of [ctx, nestedHostile]) {
      const error = Effect.runSync(Effect.flip(applyHostPreference(pi, context, preference)));
      expect(error).toBeInstanceOf(DirectoryModelHostError);
      expect(error).toMatchObject({ operation: "read" });
    }
  });
});
