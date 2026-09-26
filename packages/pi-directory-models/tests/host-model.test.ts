import * as Effect from "effect/Effect";
import { extensionApiFixture, extensionContextFixture } from "pi-cosmic-core/testing";
import { describe, expect, it } from "vitest";
import {
  applyHostPreference,
  captureContextModel,
  captureSelectedModel,
  captureThinkingLevel,
} from "../src/boundary/host-model.ts";
import { makeDirectoryModelPreference } from "../src/config/schema.ts";

describe("directory model host capture", () => {
  it("captures model fields and contains malformed or hostile host values", () => {
    expect(
      captureSelectedModel({ provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true }),
    ).toEqual({ provider: "openai-codex", id: "gpt-5.6-sol" });
    expect(captureSelectedModel({ provider: 42, id: "model" })).toBeUndefined();
    const hostile = Object.defineProperty({}, "provider", {
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

    const preference = makeDirectoryModelPreference(
      "/project",
      "openai-codex",
      "gpt-5.6-sol",
      "high",
    );
    const pi = extensionApiFixture({});
    const error = Effect.runSync(Effect.flip(applyHostPreference(pi, ctx, preference)));
    expect(error).toMatchObject({ _tag: "DirectoryModelHostError", operation: "read" });
  });
});
