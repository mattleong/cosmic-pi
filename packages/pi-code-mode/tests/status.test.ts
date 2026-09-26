import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Value } from "typebox/value";
import { afterEach, vi } from "vitest";
import { CODE_MODE_INTEGER_BOUNDS } from "../src/config/schema.ts";
import type { ResultsContract } from "../src/results/service.ts";
import { buildCodeModeToolDefinition } from "../src/tools/controller.ts";
import {
  CODE_MODE_UNAVAILABLE_MESSAGE,
  type CodeModeExecutionEnvironment,
} from "../src/tools/execution.ts";
import type { CodeModeInput } from "../src/tools/result-read.ts";
import { codeModeStatusResult } from "../src/tools/status.ts";
import {
  codeModeStatusCompactSummary,
  decodeCodeModeStatus,
  renderCodeModeStatusResult,
} from "../src/ui/status.ts";
import { opaqueFixture } from "pi-cosmic-core/testing";
import { codeModeStateFixture } from "./support/host.ts";
import { executeHarness, textOf } from "./support/execute.ts";
import { presentationView, restorePresentationSettings } from "./support/presentation.ts";

const StatusJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    action: Schema.Literal("status"),
    limits: Schema.Struct({
      timeoutMs: Schema.Int,
      maxToolCalls: Schema.Int,
      maxOutputBytes: Schema.Int,
      maxSourceBytes: Schema.Int,
      maxCumulativeChildOutputBytes: Schema.Int,
    }),
  }),
);
const UnknownJsonSchema = Schema.fromJsonString(Schema.Unknown);

function statusHarness(states: ReadonlyArray<ReturnType<typeof codeModeStateFixture>>) {
  let stateIndex = 0;
  let resultStoreTouches = 0;
  const results: ResultsContract = {
    put: () => {
      resultStoreTouches += 1;
      return Effect.die("status must not write retained results");
    },
    get: () => {
      resultStoreTouches += 1;
      return Effect.die("status must not read retained results");
    },
  };
  const executeCodeMode = vi.fn<NonNullable<CodeModeExecutionEnvironment["executeCodeMode"]>>(() =>
    Effect.die("status must not enter the interpreter"),
  );
  let sessionRunnerTouches = 0;
  const runInSession: CodeModeExecutionEnvironment["runInSession"] = (effect, signal) => {
    sessionRunnerTouches += 1;
    return Effect.runPromise(effect, signal ? { signal } : undefined);
  };
  const getState = () => {
    const state = states[Math.min(stateIndex, states.length - 1)];
    stateIndex += 1;
    return state;
  };
  const isCurrent = vi.fn(() => true);
  const { call } = executeHarness({ results, isCurrent, getState, runInSession, executeCodeMode });
  return {
    call,
    executeCodeMode,
    isCurrent,
    sessionRunnerTouches: () => sessionRunnerTouches,
    resultStoreTouches: () => resultStoreTouches,
  };
}

const runStatus = (
  harness: ReturnType<typeof statusHarness>,
  params: CodeModeInput = { action: "status" },
  signal?: AbortSignal,
) => harness.call(params, { signal });

describe("effective Code Mode status", () => {
  it.effect("returns the live five-limit snapshot without execution or retained storage", () =>
    Effect.gen(function* () {
      // Zero call, child-output, source, and time admission budgets must not refuse status.
      const admission = codeModeStateFixture({
        timeoutMs: 1,
        maxToolCalls: 0,
        maxOutputBytes: 2_000,
        maxSourceBytes: 1,
        maxCumulativeChildOutputBytes: 0,
      });
      const live = codeModeStateFixture({
        timeoutMs: 12_345,
        maxToolCalls: 0,
        maxOutputBytes: 1_000,
        maxSourceBytes: 234,
        maxCumulativeChildOutputBytes: 0,
        catalogBudget: 987,
      });
      const harness = statusHarness([admission, live]);

      const result = yield* Effect.promise(() => runStatus(harness));

      const decoded = yield* Schema.decodeEffect(StatusJsonSchema)(textOf(result));
      expect(decoded).toEqual({
        action: "status",
        limits: {
          timeoutMs: 12_345,
          maxToolCalls: 0,
          maxOutputBytes: 1_000,
          maxSourceBytes: 234,
          maxCumulativeChildOutputBytes: 0,
        },
      });
      expect(decodeCodeModeStatus(result.details)).toEqual(decoded);
      expect(textOf(result)).not.toContain("catalogBudget");
      expect(harness.executeCodeMode).not.toHaveBeenCalled();
      expect(harness.sessionRunnerTouches()).toBe(0);
      expect(harness.resultStoreTouches()).toBe(0);
    }),
  );

  it.effect("returns a bounded non-JSON refusal when the envelope cannot fit", () =>
    Effect.gen(function* () {
      for (const maxOutputBytes of [12, 0]) {
        const state = codeModeStateFixture({ maxOutputBytes });
        const result = yield* Effect.promise(() => runStatus(statusHarness([state])));
        const text = textOf(result);
        expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(maxOutputBytes);
        if (maxOutputBytes === 0) expect(text).toBe("");
        else {
          expect(text).not.toMatch(/^\s*\{/u);
          expect(Option.isNone(Schema.decodeOption(UnknownJsonSchema)(text))).toBe(true);
        }
      }
    }),
  );

  it.effect("honors cancellation, availability, and revocation before live status", () =>
    Effect.gen(function* () {
      const state = codeModeStateFixture({ maxOutputBytes: 512 });
      const cancelled = statusHarness([state]);
      const cancelledResult = yield* Effect.promise(() =>
        runStatus(cancelled, { action: "status" }, AbortSignal.abort()),
      );
      expect(cancelledResult.details.cancelled).toBe(true);
      expect(cancelled.executeCodeMode).not.toHaveBeenCalled();

      const unavailable = statusHarness([codeModeStateFixture({}, { available: false })]);
      yield* Effect.promise(() =>
        expect(runStatus(unavailable)).rejects.toThrow(CODE_MODE_UNAVAILABLE_MESSAGE),
      );
      expect(unavailable.executeCodeMode).not.toHaveBeenCalled();

      const disabledLive = statusHarness([
        state,
        codeModeStateFixture({ maxOutputBytes: 64 }, { available: false }),
      ]);
      yield* Effect.promise(() => expect(runStatus(disabledLive)).rejects.toThrow());
      expect(disabledLive.executeCodeMode).not.toHaveBeenCalled();

      const revoked = statusHarness([state]);
      revoked.isCurrent.mockReturnValueOnce(true).mockReturnValueOnce(false);
      yield* Effect.promise(() =>
        expect(runStatus(revoked)).rejects.toThrow(CODE_MODE_UNAVAILABLE_MESSAGE),
      );
      expect(revoked.executeCodeMode).not.toHaveBeenCalled();
      expect(revoked.sessionRunnerTouches()).toBe(0);
    }),
  );

  it.effect("rejects mixed forms before interpreter or storage access", () =>
    Effect.gen(function* () {
      const state = codeModeStateFixture({ maxOutputBytes: 512 });
      for (const mixed of [
        { action: "status", code: "return 1" },
        { action: "status", intent: "Inspect" },
        { action: "status", id: "saved" },
        { action: "status", offset: 0 },
        { action: "status", limit: 1 },
      ]) {
        const harness = statusHarness([state]);
        yield* Effect.promise(() =>
          expect(runStatus(harness, opaqueFixture(mixed))).rejects.toThrow(
            /Invalid Code Mode request/u,
          ),
        );
        expect(harness.executeCodeMode).not.toHaveBeenCalled();
        expect(harness.sessionRunnerTouches()).toBe(0);
        expect(harness.resultStoreTouches()).toBe(0);
      }

      const readHarness = statusHarness([state]);
      const read = yield* Effect.promise(() =>
        runStatus(
          readHarness,
          opaqueFixture({
            action: "result.read",
            id: "saved",
            intent: "forbidden",
          }),
        ),
      );
      expect(read.details.resultRead).toEqual({ status: "error", code: "invalid-input" });
      expect(readHarness.executeCodeMode).not.toHaveBeenCalled();
      expect(readHarness.resultStoreTouches()).toBe(0);
    }),
  );
});

describe("registered status presentation and discovery", () => {
  afterEach(restorePresentationSettings);

  it.each(["on", "off", "border"] as const)(
    "keeps the shared shell and raw output without execution sections in %s mode",
    (mode) => {
      for (const style of ["compact", "preview"] as const) {
        const result = codeModeStatusResult(codeModeStateFixture({ maxOutputBytes: 512 }).config);
        const { view } = presentationView(mode, style);
        view.call({ action: "status" }, { expanded: true });
        view.result(result, { expanded: true, isPartial: false });
        const rendered = view.render(160).join("\n");

        expect(rendered.split(textOf(result)), style).toHaveLength(2);
        expect(rendered, style).not.toMatch(/(^|\n)\s*(Program|Calls)(\n|$)/u);
      }
    },
  );

  it("validates producer details independently and never infers status from raw output", () => {
    const status = codeModeStatusResult(codeModeStateFixture({ maxOutputBytes: 512 }).config);
    const input = {
      phase: "settled" as const,
      args: { action: "status" },
      result: { content: [{ type: "text" as const, text: "not-json" }], details: status.details },
      context: opaqueFixture({ isError: false, expanded: false }),
    };
    expect(decodeCodeModeStatus(status.details)).toEqual(status.details.status);
    expect(codeModeStatusCompactSummary(input)?.outcome).toBe("success");
    expect(
      codeModeStatusCompactSummary({
        ...input,
        result: {
          ...input.result,
          details: {
            status: {
              action: "status",
              limits: { ...status.details.status.limits, maxToolCalls: "invalid" },
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("keeps status issue evidence visible when the host theme fails", () => {
    const status = codeModeStatusResult(codeModeStateFixture({ maxOutputBytes: 512 }).config);
    const result = { ...status, details: { ...status.details, truncated: true } };
    const context = opaqueFixture({ isError: false, expanded: true });
    const summary = codeModeStatusCompactSummary({
      phase: "settled",
      args: { action: "status" },
      result,
      context,
    });
    const hostile = opaqueFixture({
      fg: () => {
        throw new Error("theme unavailable");
      },
    });
    const view = renderCodeModeStatusResult(
      result,
      { isPartial: false },
      hostile,
      context,
      summary,
    );
    const text = view.render(160).join("\n");
    expect(summary?.issues?.entries.length).toBeGreaterThan(0);
    for (const issue of summary?.issues?.entries ?? []) expect(text).toContain(issue.cause);
    expect(text).toContain(textOf(result));
  });

  it("keeps status replay bounds and tolerant historical fields", () => {
    const base = codeModeStatusResult(codeModeStateFixture({ maxOutputBytes: 512 }).config).details
      .status;
    const limits = {
      timeoutMs: CODE_MODE_INTEGER_BOUNDS.timeoutMs.minimum,
      maxToolCalls: CODE_MODE_INTEGER_BOUNDS.maxToolCalls.minimum,
      maxOutputBytes: CODE_MODE_INTEGER_BOUNDS.maxOutputBytes.maximum,
      maxSourceBytes: CODE_MODE_INTEGER_BOUNDS.maxSourceBytes.minimum,
      maxCumulativeChildOutputBytes: CODE_MODE_INTEGER_BOUNDS.maxCumulativeChildOutputBytes.maximum,
      historicalField: true,
    };
    expect(
      decodeCodeModeStatus({
        status: { ...base, limits, historicalField: true },
        historicalField: true,
      }),
    ).toMatchObject({
      action: "status",
      limits: {
        timeoutMs: limits.timeoutMs,
        maxToolCalls: limits.maxToolCalls,
        maxOutputBytes: limits.maxOutputBytes,
        maxSourceBytes: limits.maxSourceBytes,
        maxCumulativeChildOutputBytes: limits.maxCumulativeChildOutputBytes,
      },
    });
    for (const invalid of [
      { timeoutMs: 0 },
      { maxToolCalls: -1 },
      { maxOutputBytes: CODE_MODE_INTEGER_BOUNDS.maxOutputBytes.maximum + 1 },
      { maxSourceBytes: 0 },
      { maxCumulativeChildOutputBytes: Number.MAX_SAFE_INTEGER + 1 },
      { maxToolCalls: 1.5 },
      { timeoutMs: "1000" },
    ]) {
      expect(
        decodeCodeModeStatus({ status: { ...base, limits: { ...limits, ...invalid } } }),
      ).toBeUndefined();
    }
    expect(decodeCodeModeStatus({ status: { ...base, action: "run" } })).toBeUndefined();
    expect(decodeCodeModeStatus({ status: base, truncated: "yes" })).toBeUndefined();
  });

  it("accepts only the pure status and result.read forms in the registered parameters", () => {
    const definition = buildCodeModeToolDefinition({
      catalogBudget: 123,
      includePowerShell: false,
      execute: () => Promise.reject(new Error("not executed")),
    });
    expect(Value.Check(definition.parameters, { action: "status" })).toBe(true);
    expect(Value.Check(definition.parameters, { action: "status", intent: "forbidden" })).toBe(
      false,
    );
    expect(Value.Check(definition.parameters, { action: "status", code: "return 1" })).toBe(false);
    expect(Value.Check(definition.parameters, { action: "result.read", id: "saved" })).toBe(true);
    expect(
      Value.Check(definition.parameters, {
        action: "result.read",
        id: "saved",
        intent: "forbidden",
      }),
    ).toBe(false);
  });
});
