import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type { JsonObject } from "../src/platform/json-document.ts";
import {
  BooleanFromJsonSchema,
  completeSettingsArguments,
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

describe("completeSettingsArguments", () => {
  const descriptors = [
    {
      id: "maxRunning",
      label: "Running at once",
      description: "How many tasks may run at the same time; later ones wait their turn.",
      values: ["8", "16"],
    },
  ];

  it("describes ids and values with the setting's label, not its description", () => {
    expect(completeSettingsArguments("max", descriptors)).toEqual([
      { value: "maxRunning", label: "maxRunning", description: "Running at once" },
    ]);
    expect(
      completeSettingsArguments(
        "project maxRunning 1",
        descriptors,
        [],
        [{ value: "project", label: "project", description: "This project" }],
      ),
    ).toEqual([
      {
        value: "project maxRunning 16",
        label: "project maxRunning 16",
        description: "Running at once",
      },
    ]);
  });

  it("cuts a label too long for the completion column at a word boundary", () => {
    const long = [
      { id: "visible:subagents", label: "Subagent profiles and delegation", values: ["on"] },
      { id: "unbroken", label: "Supercalifragilisticexpialidocious" },
    ];
    const descriptions = Arr.map(
      completeSettingsArguments("", long) ?? [],
      (choice) => choice.description,
    );
    expect(descriptions).toEqual(["Subagent profiles…", "Supercalifragilisti…"]);
    expect(completeSettingsArguments("visible:subagents o", long)).toEqual([
      {
        value: "visible:subagents on",
        label: "visible:subagents on",
        description: "Subagent profiles…",
      },
    ]);
  });
});
