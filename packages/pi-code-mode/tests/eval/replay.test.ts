import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { buildCodeModeToolDefinition } from "../../src/tools/controller.ts";
import { formatCodeModeSuccess } from "../../src/tools/format.ts";
import { formatHistoricalSuccess, freshFormatterMeasurements } from "../../eval/formatter.ts";
import { replayToolOverrides } from "../../eval/replay.ts";
import { runPilot } from "../../eval/pilot.ts";
import { opaqueHostFixture } from "../support/host.ts";
import { frozenWordingGuidelines } from "../../eval/wording.ts";

describe("supported replay interventions", () => {
  it("keeps the measured arms isolated from production and from each other", () => {
    const production = buildCodeModeToolDefinition({
      catalogBudget: 0,
      includePowerShell: false,
      execute: () => Promise.reject(new Error("not executed")),
    });
    const sample = {
      ok: true,
      value: { items: [false, 0, null], note: "café\n" },
      logs: ["tail"],
    } as const;
    for (const experiment of ["wording", "formatter"] as const) {
      for (const variant of ["baseline", "candidate"] as const) {
        const overrides = replayToolOverrides(experiment, variant, freshFormatterMeasurements());
        expect(overrides.wrapTool(production).promptGuidelines).toEqual(
          frozenWordingGuidelines[experiment === "formatter" ? "candidate" : variant],
        );
        const text = overrides.formatSuccess
          ? overrides.formatSuccess(sample, 10000)
          : formatCodeModeSuccess(sample);
        expect(text).toBe(
          experiment === "formatter" && variant === "baseline"
            ? formatHistoricalSuccess(sample, 10000)
            : formatCodeModeSuccess(sample),
        );
      }
    }
    expect(production.promptGuidelines).toEqual(frozenWordingGuidelines.baseline);
  });

  it.effect("does not retain an unknown experiment value in the admission error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.tryPromise(() =>
        runPilot(opaqueHostFixture({ experiment: "private-unknown-experiment" })),
      ).pipe(Effect.flip);
      expect(error.cause).toMatchObject({ _tag: "EvaluationError", operation: "preflight" });
      const serialized = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
        error,
      );
      expect(serialized).not.toContain("private-unknown-experiment");
    }),
  );
});
