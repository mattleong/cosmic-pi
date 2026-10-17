import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { JsonObject } from "../src/platform/json-document.ts";
import {
  BooleanFromJsonSchema,
  decodeSettingUpdate,
  FiniteNumberFromJsonSchema,
} from "../src/settings-completion.ts";

describe("decodeSettingUpdate", () => {
  const decodeSetting = decodeSettingUpdate<{ compact: boolean }>([
    { id: "usage.enabled", decoder: BooleanFromJsonSchema },
    { id: "usage.refreshIntervalMs", decoder: FiniteNumberFromJsonSchema },
    { id: "compact", decoder: BooleanFromJsonSchema },
  ]);

  it.effect("patches a dotted id into its section", () =>
    Effect.gen(function* () {
      const patch = yield* decodeSetting("usage.enabled", "true");
      const current: JsonObject = { other: "kept", usage: { enabled: false, stale: 1 } };
      expect(patch(current)).toEqual({
        other: "kept",
        usage: { enabled: true, stale: 1 },
      });
    }),
  );
});
