import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { provideBuiltLayer } from "pi-cosmic-core";
import { makeInMemoryDocuments } from "pi-cosmic-core/testing";
import { resolveConfig } from "../src/config/store.ts";

describe("xAI configuration", () => {
  it.effect(
    "applies project fields over global fields over defaults before clamping refresh",
    () => {
      const documents = makeInMemoryDocuments({
        "/project/.pi/extensions/pi-better-xai.json": {
          usage: {
            showOnlyOnSubscriptionModels: "invalid-project-value",
            refreshIntervalMs: 4_000,
            showResetTimes: false,
          },
        },
        "/agent/extensions/pi-better-xai.json": {
          usage: {
            refreshIntervalMs: 20_000,
            showOnlyOnSubscriptionModels: false,
          },
        },
      });

      return Effect.gen(function* () {
        const resolved = yield* resolveConfig("/project", "/agent", true);
        expect(resolved.usage).toEqual({
          refreshIntervalMs: 5_000,
          showOnlyOnSubscriptionModels: false,
          showResetTimes: false,
        });
      }).pipe(provideBuiltLayer(Layer.merge(Path.layer, documents.layer)));
    },
  );
});
