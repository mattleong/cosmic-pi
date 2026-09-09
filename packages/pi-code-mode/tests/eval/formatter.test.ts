import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CodeModeSuccess } from "../../src/boundary/codemode-runtime.ts";
import { makeNestedPiToolDefinitions } from "../../src/boundary/host-builtin-tools.ts";
import { formatCodeModeSuccess } from "../../src/tools/format.ts";
import { clampModelVisibleText } from "../../src/tools/limits.ts";
import { makeCodeModeToolExecute } from "../../src/tools/execution.ts";
import {
  formatHistoricalSuccess,
  freshFormatterMeasurements,
  measuredFormatter,
} from "../../eval/formatter.ts";
import { codeModeStateFixture, extensionContextFixture } from "../support/host.ts";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
describe("formatter comparison", () => {
  it("preserves JSON values while observing the same actual value under both policies", () => {
    const values: Schema.Json[] = [
      null,
      false,
      0,
      [],
      {},
      {
        rows: [
          { id: "a", value: 0, enabled: false, note: "a\n\nLogs:\nb" },
          { id: "b", value: null, enabled: true, note: "café" },
        ],
      },
    ];
    for (const value of values) {
      const sample = { ok: true, value } as const;
      const metrics = freshFormatterMeasurements();
      const pretty = measuredFormatter("baseline", metrics)(sample, 10000);
      const compact = formatCodeModeSuccess(sample);
      expect(decode(pretty)).toEqual(value);
      expect(decode(compact)).toEqual(value);
      expect(metrics.structuredCalls).toBe(1);
      expect(metrics.changedCalls).toBe(pretty === compact ? 0 : 1);
      expect(metrics.prettyBytes).toBe(Buffer.byteLength(pretty));
      expect(metrics.compactBytes).toBe(Buffer.byteLength(compact));
      expect(Object.values(metrics).every((item) => Number.isFinite(item))).toBe(true);
    }
  });

  it("never parses JSON-looking strings and preserves empty output and logs", () => {
    for (const value of ['{\n  "ready": false\n}\n', "", "a\n\nLogs:\nb", "café\n"]) {
      for (const logs of [[], ["first", "second\nline"]]) {
        const sample = { ok: true, value, logs } as const;
        const metrics = freshFormatterMeasurements();
        expect(measuredFormatter("baseline", metrics)(sample, 1000)).toBe(
          formatCodeModeSuccess(sample),
        );
        expect(metrics.stringCalls).toBe(1);
        expect(metrics.structuredCalls).toBe(0);
        expect(metrics.changedCalls).toBe(0);
      }
    }
  });

  it("uses the value-only pretty fallback before appending logs and applying the caller clamp", () => {
    const sample: CodeModeSuccess = { ok: true, value: { items: [1, 2] } };
    const compact = formatCodeModeSuccess(sample);
    const metrics = freshFormatterMeasurements();
    expect(measuredFormatter("baseline", metrics)(sample, Buffer.byteLength(compact))).toBe(
      compact,
    );
    expect(metrics.prettyFallbackCalls).toBe(1);
    expect(metrics.changedCalls).toBe(0);
    const pretty = JSON.stringify(sample.value, null, 2);
    const withLogs: CodeModeSuccess = { ...sample, logs: ["é"] };
    const observed = freshFormatterMeasurements();
    expect(measuredFormatter("baseline", observed)(withLogs, Buffer.byteLength(pretty))).toBe(
      pretty + "\n\nLogs:\né",
    );
    expect(observed.prettyFallbackCalls).toBe(0);
    expect(observed.clampedCalls).toBe(1);
  });

  it.effect(
    "keeps the production default and retains final clamp ownership and structured metadata",
    () =>
      Effect.gen(function* () {
        const run = Effect.runPromiseWith(yield* Effect.context());
        const sample: CodeModeSuccess = {
          ok: true,
          value: { items: [1, 2], label: "café" },
          logs: ["tail"],
        };
        for (const budget of [20, 1000]) {
          const ctx = extensionContextFixture({ cwd: "/tmp" });
          const base = {
            isCurrent: () => true,
            getState: () => codeModeStateFixture({ maxOutputBytes: budget }),
            runInSession: <A>(effect: Effect.Effect<A>, signal?: AbortSignal) =>
              run(effect, { signal }),
            definitions: makeNestedPiToolDefinitions("/tmp"),
            events: createEventBus(),
            sessionId: "formatter-test",
            executeCodeMode: () => Effect.succeed(sample),
          };
          const current = yield* Effect.tryPromise(() =>
            makeCodeModeToolExecute(base)(
              "current",
              { code: "return null;" },
              undefined,
              undefined,
              ctx,
            ),
          );
          const seen: number[] = [];
          const old = yield* Effect.tryPromise(() =>
            makeCodeModeToolExecute({
              ...base,
              formatSuccess: (result, limit) => {
                seen.push(limit);
                return formatHistoricalSuccess(result, limit);
              },
            })("old", { code: "return null;" }, undefined, undefined, ctx),
          );
          expect(seen).toEqual([budget]);
          expect(current.content).toEqual([
            { type: "text", text: clampModelVisibleText(formatCodeModeSuccess(sample), budget) },
          ]);
          expect(old.content).toEqual([
            {
              type: "text",
              text: clampModelVisibleText(formatHistoricalSuccess(sample, budget), budget),
            },
          ]);
          expect(current.details.outputKind).toBe("structured");
          expect(old.details.outputKind).toBe("structured");
        }
      }),
  );
});
