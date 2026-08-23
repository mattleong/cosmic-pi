import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { JsonObject } from "pi-cosmic-core";
import { InvalidSettingError, decodeSettingUpdate } from "../src/config/options.ts";

describe("xAI setting updates", () => {
  it.effect("parses each descriptor value from its persisted string form", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, string]> = [
        ["usage.enabled", "false"],
        ["usage.refreshIntervalMs", "60000"],
        ["usage.showOnlyOnSubscriptionModels", "true"],
        ["usage.showResetTimes", "false"],
        ["footer.mode", "status"],
      ];
      for (const [id, raw] of cases) {
        const update = yield* decodeSettingUpdate(id, raw);
        expect(update({})).not.toEqual({});
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
      const update = yield* decodeSettingUpdate("footer.mode", "off");
      expect(update({ footer: "corrupt" })).toEqual({ footer: { mode: "off" } });
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
      const modeFailure = yield* decodeSettingUpdate("footer.mode", "other").pipe(Effect.flip);
      expect(modeFailure).toBeInstanceOf(InvalidSettingError);
    }),
  );
});
