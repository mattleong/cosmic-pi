import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
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
    expect(() => captureSelectedModel(hostile)).not.toThrow();
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
    // SAFETY: The tested operation fails at the model getter before reading other host members.
    const ctx = hostileContext as ExtensionContext;
    expect(captureContextModel(ctx)).toBeUndefined();

    const preference = makeDirectoryModelPreference(
      "/project",
      "openai-codex",
      "gpt-5.6-sol",
      "high",
    );
    // SAFETY: The tested operation fails before reading any ExtensionAPI member.
    const pi = {} as ExtensionAPI;
    const error = Effect.runSync(Effect.flip(applyHostPreference(pi, ctx, preference)));
    expect(error).toMatchObject({ _tag: "DirectoryModelHostError", operation: "read" });
  });
});
