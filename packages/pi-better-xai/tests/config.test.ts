import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { provideBuiltLayer, InvalidSettingError, type JsonObject } from "pi-cosmic-core";
import { makeInMemoryDocuments } from "pi-cosmic-core/testing";
import { decodeSettingUpdate } from "../src/config/options.ts";
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

  it.effect("patches the exact dotted path for every setting id", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, string, JsonObject]> = [
        ["usage.refreshIntervalMs", "60000", { usage: { refreshIntervalMs: 60_000 } }],
        [
          "usage.showOnlyOnSubscriptionModels",
          "true",
          { usage: { showOnlyOnSubscriptionModels: true } },
        ],
        ["usage.showResetTimes", "false", { usage: { showResetTimes: false } }],
      ];
      for (const [id, raw, expected] of cases) {
        const update = yield* decodeSettingUpdate(id, raw);
        expect(update({})).toEqual(expected);
      }
    }),
  );

  it.effect("patches one section key while preserving unknown shapes and sibling keys", () =>
    Effect.gen(function* () {
      const update = yield* decodeSettingUpdate("usage.refreshIntervalMs", "15000");
      const raw: JsonObject = {
        unknown: "preserved",
        usage: { enabled: true, refreshIntervalMs: 30_000 },
      };
      expect(update(raw)).toEqual({
        unknown: "preserved",
        usage: { enabled: true, refreshIntervalMs: 15_000 },
      });
    }),
  );

  it.effect("replaces a non-object section instead of failing", () =>
    Effect.gen(function* () {
      const update = yield* decodeSettingUpdate("usage.showResetTimes", "false");
      expect(update({ usage: "corrupt" })).toEqual({ usage: { showResetTimes: false } });
    }),
  );

  it.effect("rejects unknown option ids with the typed error", () =>
    Effect.gen(function* () {
      const failure = yield* decodeSettingUpdate("usage.nonexistent", "true").pipe(Effect.flip);
      expect(failure).toBeInstanceOf(InvalidSettingError);
    }),
  );

  it.effect("rejects invalid values with the typed error", () =>
    Effect.gen(function* () {
      const intervalFailure = yield* decodeSettingUpdate("usage.refreshIntervalMs", "NaN").pipe(
        Effect.flip,
      );
      expect(intervalFailure).toBeInstanceOf(InvalidSettingError);
      const modeFailure = yield* decodeSettingUpdate("usage.showResetTimes", "other").pipe(
        Effect.flip,
      );
      expect(modeFailure).toBeInstanceOf(InvalidSettingError);
    }),
  );
});
