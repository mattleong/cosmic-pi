import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as core from "pi-cosmic-core";
import { vi } from "vitest";
import { makeChildTimings, liveChildElapsed } from "../src/boundary/host-child-timing.ts";
import { codeModeCompactSummaryAtHost } from "../src/boundary/host-render-ticker.ts";
import { codeModeCompactSummary } from "../src/ui/compact-summary.ts";
import { callEntryDetails, type CodeModeToolDetails } from "../src/tools/format.ts";
import { executeHarness } from "./support/execute.ts";
import { deferredPromise, opaqueFixture } from "pi-cosmic-core/testing";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";

const nativeResult = { content: [{ type: "text" as const, text: "done" }], details: {} };
const input = <D>(details: D, phase: "running" | "settled" = "running") => ({
  phase,
  args: {},
  result: { content: [], details },
  context: opaqueFixture({
    state: {},
    isError: false,
    isPartial: phase === "running",
    expanded: false,
  }),
});
const durations = (summary: ReturnType<typeof codeModeCompactSummary>) =>
  summary?.children?.entries.map((entry) => entry.durationMs);
const live = <D>(details: D, now: number, phase: "running" | "settled" = "running") =>
  durations(
    codeModeCompactSummary(
      input(details, phase),
      liveChildElapsed(() => now),
    ),
  );

const json = Schema.fromJsonString(Schema.Unknown);
const replay = <Value>(value: Value) =>
  Schema.decodeUnknownSync(json)(Schema.encodeSync(json)(value));

describe("live nested timing", () => {
  it("keeps concurrent clocks independent and revokes snapshots without persisting timestamps", () => {
    let now = 1000;
    const timing = makeChildTimings(() => now);
    const first = timing.start()!;
    now = 1500;
    const second = timing.start()!;
    const calls = [first, second].map((liveTiming) => ({
      tool: "pi.bash",
      status: "running" as const,
      liveTiming,
    }));
    const details = callEntryDetails(calls);
    now = 3000;
    expect(live(details, now)).toEqual([2000, 1500]);
    now = 4000;
    expect(live(details, now)).toEqual([3000, 2500]);
    expect(live(replay(details), now)).toEqual([undefined, undefined]);
    timing.stop(first);
    expect(live(details, now)).toEqual([undefined, 2500]);
    timing.close();
    expect(live(details, now)).toEqual([undefined, undefined]);
    expect(timing.start()).toBeUndefined();
  });

  it("never times queued or replayed running calls and preserves authoritative settlement", () => {
    const timing = makeChildTimings(() => 5000);
    const liveTiming = timing.start()!;
    const details = callEntryDetails([
      { tool: "pi.bash", status: "queued", liveTiming, durationMs: 123 },
      { tool: "pi.bash", status: "running", durationMs: 123 },
      { tool: "pi.bash", status: "running", liveTiming },
      { tool: "pi.bash", status: "completed", durationMs: 9000 },
      { tool: "pi.bash", status: "cancelled" },
    ]);
    try {
      // The settled measurement can include queue wait. Never replace it with a live estimate.
      expect(live(details, 6000)).toEqual([undefined, undefined, 1000, 9000, undefined]);
      expect(live(details, 6000, "settled")).toEqual([
        undefined,
        undefined,
        undefined,
        9000,
        undefined,
      ]);
      expect(
        codeModeCompactSummary(input(details))?.children?.entries.every(
          (child) => child.showTiming === undefined,
        ),
      ).toBe(true);
    } finally {
      timing.close();
    }
  });

  it("contains unavailable clocks and clamps backwards clock movement", () => {
    const broken = makeChildTimings(() => {
      throw new Error("clock unavailable");
    });
    expect(broken.start()).toBeUndefined();
    const timing = makeChildTimings(() => 100);
    const call = { tool: "pi.bash", status: "running" as const, liveTiming: timing.start()! };
    expect(liveChildElapsed(() => 50)(call)).toBe(0);
    expect(liveChildElapsed(() => Number.NaN)(call)).toBeUndefined();
    timing.close();
  });

  it.effect.each(["success", "error", "cancelled"] as const)(
    "advances between host frames without new progress and cleans up on %s",
    (outcome) =>
      Effect.gen(function* () {
        let now = 1000;
        const clock = vi.spyOn(core, "synchronousNow").mockImplementation(() => now);
        const ready = deferredPromise();
        const firstDone = deferredPromise();
        const waits = [1, 2].map(() => deferredPromise<typeof nativeResult>());
        let count = 0;
        let progress: AgentToolResult<CodeModeToolDetails> | undefined;
        const controller = new AbortController();
        const run = executeHarness({
          definitions: nestedToolDefinitionsFixture({
            bash: {
              execute: () => {
                const index = count++;
                now = 2000;
                if (count === 2) ready.resolve();
                return waits[index]!.promise.then((value) => {
                  if (index === 1 && outcome === "error")
                    throw new Error("Command exited with code 1");
                  return value;
                });
              },
            },
          }),
        }).run(
          'try { await Promise.all([1,2].map(() => tools.pi.bash({command:"same"}))); } catch {} return 1',
          {
            signal: controller.signal,
            onUpdate: (value) => {
              progress = value;
              if (value.details?.toolCalls[0]?.status === "completed") firstDone.resolve();
            },
          },
        );
        try {
          yield* Effect.promise(() => ready.promise);
          const running = progress!.details!;
          now = 3000;
          expect(durations(codeModeCompactSummaryAtHost(input(running)))).toEqual([2000, 1000]);
          now = 4000;
          expect(durations(codeModeCompactSummaryAtHost(input(running)))).toEqual([3000, 2000]);
          waits[0]!.resolve(nativeResult);
          yield* Effect.promise(() => firstDone.promise);
          expect(durations(codeModeCompactSummaryAtHost(input(running)))).toEqual([
            undefined,
            2000,
          ]);
          if (outcome === "cancelled") controller.abort();
          else waits[1]!.resolve(nativeResult);
          const result = yield* Effect.promise(() => run);
          now = 9000;
          expect(durations(codeModeCompactSummaryAtHost(input(running)))).toEqual([
            undefined,
            undefined,
          ]);
          expect(result.details?.toolCalls.every((call) => call.liveTiming === undefined)).toBe(
            true,
          );
          expect(result.details?.toolCalls[1]?.status).toBe(
            outcome === "success" ? "completed" : outcome === "error" ? "error" : "cancelled",
          );
        } finally {
          controller.abort();
          waits.forEach((wait) => wait.resolve(nativeResult));
          clock.mockRestore();
        }
      }),
  );
});
