import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { JsonObject } from "../src/platform/json-document.ts";
import {
  BooleanFromJsonSchema,
  completeSettingsArguments,
  decodeSettingUpdate,
  FiniteNumberFromJsonSchema,
  InvalidSettingError,
  sectionSettingValue,
} from "../src/settings-completion.ts";

describe("sectionSettingValue", () => {
  it("creates a missing section without disturbing sibling keys", () => {
    const current: JsonObject = { other: "kept" };
    expect(sectionSettingValue("usage", "enabled", true)(current)).toEqual({
      other: "kept",
      usage: { enabled: true },
    });
  });

  it.each([
    ["a string section", "not-an-object"],
    ["an array section", [1, 2]],
    ["a null section", null],
  ])("replaces %s with an object holding the assigned key", (_label, existing) => {
    // SAFETY: Each fixture is a JSON-encodable literal satisfying the JsonObject contract.
    const current = { footer: existing } as JsonObject;
    expect(sectionSettingValue("footer", "mode", "status")(current)).toEqual({
      footer: { mode: "status" },
    });
  });
});

describe("decodeSettingUpdate", () => {
  const decodeSetting = decodeSettingUpdate<{ compact: boolean }>([
    { id: "usage.enabled", decoder: BooleanFromJsonSchema },
    { id: "usage.refreshIntervalMs", decoder: FiniteNumberFromJsonSchema },
    { id: "compact", decoder: BooleanFromJsonSchema },
  ]);

  it.effect.each([
    ["nope", "true"],
    ["usage.enabled", "not-json"],
  ] as const)("fails setting %s = %s with an id-scoped InvalidSettingError", ([id, value]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeSetting(id, value));
      expect(error).toBeInstanceOf(InvalidSettingError);
      expect(error.id).toBe(id);
    }),
  );

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

  it.effect("patches a separator-less id at the top level", () =>
    Effect.gen(function* () {
      const patch = yield* decodeSetting("compact", "true");
      expect(patch({ footer: { mode: "status" } })).toEqual({
        footer: { mode: "status" },
        compact: true,
      });
    }),
  );
});

describe("completeSettingsArguments", () => {
  const descriptors = [
    {
      id: "usage.enabled",
      description: "Toggle usage.",
      values: ["true", "false"] as const,
    },
  ];

  it("completes option ids and their values case-insensitively", () => {
    expect(completeSettingsArguments("usa", descriptors)).toEqual([
      { value: "usage.enabled", label: "usage.enabled", description: "Toggle usage." },
    ]);
    expect(completeSettingsArguments("usage.enabled tru", descriptors)).toEqual([
      {
        value: "usage.enabled true",
        label: "usage.enabled true",
        description: "Toggle usage.",
      },
    ]);
  });

  it("returns null when nothing matches, never an empty array", () => {
    expect(completeSettingsArguments("zzz", descriptors)).toBeNull();
    expect(completeSettingsArguments("usage.enabled zzz", descriptors)).toBeNull();
  });
});
