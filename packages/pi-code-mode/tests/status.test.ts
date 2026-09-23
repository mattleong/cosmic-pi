import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { withCodePreviewShell } from "pi-code-previews";
import { createToolPresentationHarness } from "pi-code-previews/testing";
import { Value } from "typebox/value";
import { vi } from "vitest";
import {
  codePreviewSettings,
  setCodePreviewSettings,
} from "../../pi-code-previews/src/config/state.ts";
import { DEFAULT_CODE_MODE_CONFIG } from "../src/config/schema.ts";
import type { ResultsContract } from "../src/results/service.ts";
import { buildCodeModeToolDefinition } from "../src/tools/controller.ts";
import {
  CODE_MODE_UNAVAILABLE_MESSAGE,
  makeCodeModeToolExecute,
  type CodeModeExecutionEnvironment,
} from "../src/tools/execution.ts";
import type { CodeModeInput } from "../src/tools/result-read.ts";
import { codeModeStatusResult } from "../src/tools/status.ts";
import { codeModeStatusCompactSummary, decodeCodeModeStatus } from "../src/ui/status.ts";
import {
  codeModeStateFixture,
  extensionContextFixture,
  opaqueHostFixture,
} from "./support/host.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";

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
const ctx = extensionContextFixture({ cwd: "/project" });
const textOf = (result: {
  content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}) => result.content.map((part) => part.text ?? "").join("\n");

const theme = opaqueHostFixture({
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
});

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
    clear: Effect.die("status must not clear retained results"),
  };
  const executeCodeMode = vi.fn<NonNullable<CodeModeExecutionEnvironment["executeCodeMode"]>>(() =>
    Effect.die("status must not enter the interpreter"),
  );
  let sessionRunnerTouches = 0;
  const runInSession: CodeModeExecutionEnvironment["runInSession"] = (effect, signal) => {
    sessionRunnerTouches += 1;
    return Effect.runPromise(effect, signal ? { signal } : undefined);
  };
  const getState = vi.fn(() => {
    const state = states[Math.min(stateIndex, states.length - 1)];
    stateIndex += 1;
    return state;
  });
  const isCurrent = vi.fn(() => true);
  const execute = makeCodeModeToolExecute({
    results,
    isCurrent,
    getState,
    runInSession,
    definitions: nestedToolDefinitionsFixture({}),
    events: createEventBus(),
    sessionId: "status-test",
    executeCodeMode,
  });
  return {
    execute,
    executeCodeMode,
    getState,
    isCurrent,
    runInSession,
    sessionRunnerTouches: () => sessionRunnerTouches,
    resultStoreTouches: () => resultStoreTouches,
  };
}

const runStatus = (
  harness: ReturnType<typeof statusHarness>,
  params: CodeModeInput = { action: "status" },
  signal?: AbortSignal,
) => harness.execute("status", params, signal, undefined, ctx);

describe("effective Code Mode status", () => {
  it.effect("returns the live five-limit snapshot without execution or retained storage", () =>
    Effect.gen(function* () {
      const admission = codeModeStateFixture({ maxToolCalls: 99, maxOutputBytes: 2_000 });
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
      expect(harness.getState).toHaveBeenCalledTimes(2);
      expect(harness.executeCodeMode).not.toHaveBeenCalled();
      expect(harness.sessionRunnerTouches()).toBe(0);
      expect(harness.resultStoreTouches()).toBe(0);
    }),
  );

  it.effect("does not spend zero call, child-output, source, or time budgets", () =>
    Effect.gen(function* () {
      const state = codeModeStateFixture({
        timeoutMs: 1,
        maxToolCalls: 0,
        maxSourceBytes: 1,
        maxCumulativeChildOutputBytes: 0,
        maxOutputBytes: 512,
      });
      const harness = statusHarness([state]);
      const result = yield* Effect.promise(() => runStatus(harness));
      expect(yield* Schema.decodeEffect(StatusJsonSchema)(textOf(result))).toMatchObject({
        action: "status",
      });
      expect(harness.executeCodeMode).not.toHaveBeenCalled();
      expect(harness.sessionRunnerTouches()).toBe(0);
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
      expect(cancelled.getState).toHaveBeenCalledTimes(1);
      expect(cancelled.executeCodeMode).not.toHaveBeenCalled();

      const unavailable = statusHarness([codeModeStateFixture({}, { available: false })]);
      yield* Effect.promise(() =>
        expect(runStatus(unavailable)).rejects.toThrow(CODE_MODE_UNAVAILABLE_MESSAGE),
      );
      expect(unavailable.getState).toHaveBeenCalledTimes(1);
      expect(unavailable.executeCodeMode).not.toHaveBeenCalled();

      const disabledLive = statusHarness([
        state,
        codeModeStateFixture({ maxOutputBytes: 64 }, { available: false }),
      ]);
      yield* Effect.promise(() => expect(runStatus(disabledLive)).rejects.toThrow());
      expect(disabledLive.getState).toHaveBeenCalledTimes(2);
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
          expect(runStatus(harness, opaqueHostFixture(mixed))).rejects.toThrow(
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
          opaqueHostFixture({
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
  it.each(["on", "off", "border"] as const)(
    "keeps the shared shell and raw output without execution sections in %s mode",
    (mode) => {
      const previous = codePreviewSettings;
      try {
        for (const style of ["compact", "preview"] as const) {
          setCodePreviewSettings({
            ...previous,
            toolCallCollapsedStyle: style,
            toolCallTiming: false,
          });
          const state = codeModeStateFixture({ maxOutputBytes: 512 });
          const result = codeModeStatusResult(state.config);
          const owned = buildCodeModeToolDefinition({
            catalogBudget: 77,
            configSnapshot: state.config,
            includePowerShell: false,
            execute: () => Promise.reject(new Error("presentation must not execute")),
            startUiTicker: () => () => undefined,
          });
          const tool = withCodePreviewShell(owned, {
            mode,
            compactSummary: owned.compactSummary,
            expandedContent: owned.expandedContent,
          });
          const view = createToolPresentationHarness(tool, { theme, width: 160 });
          view.call({ action: "status" }, { expanded: true });
          view.result(result, { expanded: true, isPartial: false });
          const rendered = view.render().join("\n");

          expect(rendered.split(textOf(result)), style).toHaveLength(2);
          expect(rendered, style).not.toMatch(/(^|\n)\s*(Program|Calls)(\n|$)/u);
        }
      } finally {
        setCodePreviewSettings(previous);
      }
    },
  );

  it("validates producer details independently and never infers status from raw output", () => {
    const status = codeModeStatusResult(codeModeStateFixture({ maxOutputBytes: 512 }).config);
    const input = {
      phase: "settled" as const,
      args: { action: "status" },
      result: { content: [{ type: "text" as const, text: "not-json" }], details: status.details },
      context: opaqueHostFixture({ isError: false, expanded: false }),
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

  it("labels generated defaults and registration snapshots without presenting them as live", () => {
    const snapshot = {
      ...DEFAULT_CODE_MODE_CONFIG,
      timeoutMs: 45_678,
      catalogBudget: 123,
    };
    const definition = buildCodeModeToolDefinition({
      catalogBudget: snapshot.catalogBudget,
      configSnapshot: snapshot,
      includePowerShell: false,
      execute: () => Promise.reject(new Error("not executed")),
    });
    expect(definition.description).toContain(
      `Package numeric defaults are timeoutMs=${DEFAULT_CODE_MODE_CONFIG.timeoutMs}`,
    );
    expect(definition.description).toContain("registration snapshot");
    expect(definition.description).toContain("timeoutMs=45678");
    expect(definition.description).toContain("catalogBudget=123 at registration");
    expect(definition.description).toContain("Status is authoritative only for its invocation");

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
