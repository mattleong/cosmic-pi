import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/platform/json-document.ts";
import { completeSettingsArguments, sectionSettingValue } from "../src/settings-completion.ts";

describe("sectionSettingValue", () => {
  it("creates a missing section without disturbing sibling keys", () => {
    const current: JsonObject = { other: "kept" };
    expect(sectionSettingValue("usage", "enabled", true)(current)).toEqual({
      other: "kept",
      usage: { enabled: true },
    });
  });

  it("overrides one key while preserving the rest of the section", () => {
    const current: JsonObject = { top: 1, usage: { enabled: true, refreshIntervalMs: 30_000 } };
    const next = sectionSettingValue("usage", "refreshIntervalMs", 15_000)(current);
    expect(next).toEqual({ top: 1, usage: { enabled: true, refreshIntervalMs: 15_000 } });
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
