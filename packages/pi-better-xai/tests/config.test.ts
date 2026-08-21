// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/strictEffectProvide:off
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type { JsonObject } from "pi-cosmic-core";
import { InvalidSettingError, decodeSettingUpdate } from "../src/config/options.ts";

const runUpdate = async (id: string, raw: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const update = yield* decodeSettingUpdate(id, raw);
      return update;
    }),
  );

describe("xAI setting updates", () => {
  it("parses each descriptor value from its persisted string form", async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["usage.enabled", "false"],
      ["usage.refreshIntervalMs", "60000"],
      ["usage.showOnlyOnSubscriptionModels", "true"],
      ["usage.showResetTimes", "false"],
      ["footer.mode", "status"],
    ];
    for (const [id, raw] of cases) {
      const update = await runUpdate(id, raw);
      expect(update({})).not.toEqual({});
    }
  });

  it("patches one section key while preserving unknown shapes and sibling keys", async () => {
    const update = await runUpdate("usage.refreshIntervalMs", "15000");
    const raw: JsonObject = {
      unknown: "preserved",
      usage: { enabled: true, refreshIntervalMs: 30_000 },
    };
    expect(update(raw)).toEqual({
      unknown: "preserved",
      usage: { enabled: true, refreshIntervalMs: 15_000 },
    });
  });

  it("replaces a non-object section instead of failing", async () => {
    const update = await runUpdate("footer.mode", "off");
    expect(update({ footer: "corrupt" })).toEqual({ footer: { mode: "off" } });
  });

  it("returns an identity patch for an unknown option id", async () => {
    const update = await runUpdate("usage.nonexistent", "true");
    const raw: JsonObject = { usage: { enabled: true } };
    expect(update(raw)).toEqual(raw);
  });

  it("rejects invalid values with the typed error", async () => {
    const failure = await Effect.runPromise(
      decodeSettingUpdate("usage.refreshIntervalMs", "NaN").pipe(Effect.flip),
    );
    expect(failure).toBeInstanceOf(InvalidSettingError);
    await expect(runUpdate("footer.mode", "other")).rejects.toBeDefined();
  });
});
