import { expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { extensionContextFixture, recordingExtensionHost } from "pi-cosmic-core/testing";
import { vi } from "vitest";
import { betterOpenAIWithDependencies } from "../src/application.ts";
import { pngPart, textPart } from "./image-fixtures.ts";

it.effect("labels a delivered image as the user's command result and keeps the image", () =>
  Effect.gen(function* () {
    const host = recordingExtensionHost(
      {},
      { registerFlag: vi.fn(), events: { emit: vi.fn(), on: vi.fn() } },
    );
    betterOpenAIWithDependencies(host.pi);
    const stored = {
      role: "custom" as const,
      customType: "openai-image",
      content: [textPart("Generated image.\nPrompt: a lighthouse"), pngPart],
      display: true,
      timestamp: 1,
    };

    const [sent] = yield* Effect.promise(() =>
      host.modelContext(extensionContextFixture(), [stored]),
    );

    if (sent?.role !== "custom" || Predicate.isString(sent.content))
      throw new Error("Expected a structured image message.");
    expect(sent.content).toContainEqual(pngPart);
    const text = Arr.join(
      Arr.map(sent.content, (part) => (part.type === "text" ? part.text : "")),
      "",
    );
    expect(text).toContain("<pi_extension_message");
    expect(text).toContain("/openai image command");
    expect(text).not.toContain("not typed by the user");
    expect(text).toContain("Prompt: a lighthouse");
  }),
);
