import assert from "node:assert/strict";
import { createReadToolDefinition, type ReadToolInput } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { provideBuiltLayer } from "pi-cosmic-core/testing";
import { applyPresentationSettings, renderContextFixture } from "../../testing";
import { CodePreviewSchedulerService } from "../../src/application/scheduler";
import {
  clearCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
} from "../../src/application/capability";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import type { ToolCallBackgroundMode, ToolCallCollapsedStyle } from "../../src/config/schema";
import { setCodePreviewSettings } from "../../src/config/state";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";
import type {
  CompactAnimationScheduler,
  CompactSummary,
  CompactSummaryProvider,
} from "../../src/tools/compact-summary";
import type { ToolRenderContext } from "../../src/tools/renderers/shared/types";
import { plainTheme, textResult as result } from "../support/render";
import { SPINNER_FRAME_MS } from "pi-cosmic-ui/manager";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

type Definition = ReturnType<typeof createReadToolDefinition>;
type Result = Awaited<ReturnType<Definition["execute"]>>;
interface State {
  codePreviewTimingStartedAt?: number;
  codePreviewTimingEndedAt?: number;
  codePreviewTimingOnlyRenderToken?: number;
}
type Context = ToolRenderContext<State, ReadToolInput>;
type Provider = CompactSummaryProvider<ReadToolInput, Result["details"], State>;
const textOf = (value: Result | undefined) =>
  Arr.join(
    Arr.map(value?.content ?? [], (part) => (part.type === "text" ? part.text : "")),
    "\n",
  );
const summarize: Provider = ({ args, phase, result: value }) => {
  const summary: CompactSummary = {
    subject: args.path ?? "",
    metadata: value ? [textOf(value)] : [],
  };
  if (phase === "settled") summary.outcome = "success";
  return summary;
};

beforeEach(() => applyPresentationSettings({}));
afterEach(() => clearCodePreviewSessionCapability());

function installRecordingScheduler() {
  const scheduled = new Set<() => void>();
  installCodePreviewSessionCapability({
    run: () => Promise.reject(new Error("not used")),
    defer: () => () => undefined,
    schedule: (_interval, task) => {
      scheduled.add(task);
      return () => {
        scheduled.delete(task);
      };
    },
  });
  return scheduled;
}

function harness(
  provider: Provider = summarize,
  mode: ToolCallBackgroundMode = "off",
  options: {
    call?: NonNullable<Definition["renderCall"]>;
    result?: NonNullable<Definition["renderResult"]>;
    timing?: boolean;
    style?: ToolCallCollapsedStyle;
    scheduleAnimation?: CompactAnimationScheduler;
  } = {},
) {
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    toolCallCollapsedStyle: options.style ?? "compact",
    toolCallTiming: options.timing ?? false,
  });
  const definition = {
    ...createReadToolDefinition("/project"),
    renderCall:
      options.call ?? ((_args, _theme, context) => new Text(`CALL ${context.args.path}`, 0, 0)),
    renderResult: options.result ?? ((value) => new Text(`BODY ${textOf(value)}`, 0, 0)),
  } satisfies Definition;
  const tool = withCodePreviewShell(definition, {
    mode,
    compactSummary: provider,
    ...(options.scheduleAnimation && { scheduleAnimation: options.scheduleAnimation }),
  });
  const state: State = {};
  let context: Context = renderContextFixture({
    args: { path: "file.ts" },
    state,
    argsComplete: false,
  });
  let callSlot: Component | undefined;
  let resultSlot: Component | undefined;
  let retainedResult: Result | undefined;
  return {
    tool,
    state,
    call(overrides: Partial<Context> = {}) {
      context = { ...context, ...overrides, lastComponent: callSlot };
      callSlot = tool.renderCall(context.args, plainTheme, context);
      return callSlot;
    },
    result(value: Result, overrides: Partial<Context> = {}) {
      retainedResult = value;
      context = { ...context, ...overrides, lastComponent: resultSlot };
      resultSlot = tool.renderResult(
        value,
        { expanded: context.expanded, isPartial: context.isPartial },
        plainTheme,
        context,
      );
      return resultSlot;
    },
    update(overrides: Partial<Context> = {}, value = retainedResult) {
      this.call(overrides);
      if (value) this.result(value);
      return this.rows();
    },
    rows(width = 120) {
      return [...(callSlot?.render(width) ?? []), ...(resultSlot?.render(width) ?? [])];
    },
  };
}

test("one stable compact call carries pending, executing, streaming and final metadata", () => {
  let bodyWork = 0;
  const h = harness(summarize, "off", {
    call: () => {
      bodyWork++;
      return new Text("pending expensive diff", 0, 0);
    },
    result: () => {
      bodyWork++;
      return new Text("output detail", 0, 0);
    },
  });
  const shell = h.call();
  assert.equal(h.rows().length, 1);
  h.update({ executionStarted: true, argsComplete: true });
  h.update({}, result("stream-one"));
  assert.equal(h.rows().length, 1);
  assert.equal(h.call(), shell);
  h.update({ isPartial: false }, result("final-count"));
  assert.equal(h.rows().length, 1);
  assert.match(Arr.join(h.rows(), ""), /final-count/u);
  assert.doesNotMatch(Arr.join(h.rows(), ""), /stream-one/u);
  assert.equal(bodyWork, 0, "compact summaries must avoid hidden diff/output computation");
});

test("call-before-final does not promote retained streaming output to a final summary", () => {
  const seen: Array<{ phase: string; text: string }> = [];
  const h = harness((input) => {
    seen.push({ phase: input.phase, text: textOf(input.result) });
    return summarize(input);
  });
  h.update({ executionStarted: true }, result("stale-stream"));
  h.call({ isPartial: false });
  h.rows();
  assert.deepEqual(seen.at(-1), { phase: "running", text: "" });
  h.result(result("settled-output"));
  h.rows();
  assert.deepEqual(seen.at(-1), { phase: "settled", text: "settled-output" });
});

test("replayed finals settle without execution or argument-completion flags and without timing", () => {
  const h = harness(summarize, "off", { timing: true });
  h.update({ isPartial: false }, result("recorded-final"));
  assert.match(Arr.join(h.rows(), ""), /recorded-final/u);
  assert.equal(h.state.codePreviewTimingStartedAt, undefined);
  assert.equal(h.state.codePreviewTimingEndedAt, undefined);
});

test("missing outcomes, malformed summaries, declines and throwing providers keep original bodies on expansion", () => {
  const body = Arr.join(
    Array.from({ length: 100 }, (_, index) => `recovery-step-${index}`),
    "\n",
  );
  const malformed: CompactSummary = { subject: "subject", outcome: "warning" };
  Reflect.set(malformed, "issues", [{ severity: "fatal", code: "bad", message: "MALFORMED" }]);
  for (const mode of ["on", "off", "border"] as const) {
    for (const provider of [
      () => undefined,
      () => ({ subject: "subject" }),
      () => malformed,
      () => {
        throw new Error("summary failure");
      },
    ] satisfies Provider[]) {
      for (const isError of [false, true]) {
        const h = harness(provider, mode);
        const rows = h.update({ isPartial: false, isError }, result(body));
        assert.equal(rows.length, isError ? 2 : 1);
        const collapsed = Arr.join(rows, "\n");
        assert.doesNotMatch(collapsed, /CALL file.ts|MALFORMED|recovery-step-[1-9]/u);
        assert.equal(Fn.pipe(collapsed, Str.includes("recovery-step-0")), isError);
        const expanded = Arr.join(h.update({ expanded: true }), "\n");
        assert.match(expanded, /CALL file.ts/u);
        assert.doesNotMatch(expanded, /MALFORMED/u);
        for (const step of Str.split(body, "\n")) assert.ok(Fn.pipe(expanded, Str.includes(step)));
      }
    }
  }
});

test("timing starts only on observed execution, freezes on final and remains independent across calls", () => {
  const scheduled = installRecordingScheduler();
  const first = harness(summarize, "off", { timing: true });
  const second = harness(summarize, "off", { timing: true });
  first.call();
  assert.equal(scheduled.size, 0);
  first.call({ executionStarted: true, invalidate: () => undefined });
  second.call({ executionStarted: true, invalidate: () => undefined });
  assert.equal(scheduled.size, 2);
  first.update({ isPartial: false }, result("first-final"));
  const frozen = first.state.codePreviewTimingEndedAt;
  assert.notEqual(frozen, undefined);
  assert.equal(scheduled.size, 1);
  first.update({}, result("updated metadata"));
  assert.equal(first.state.codePreviewTimingEndedAt, frozen);
  assert.equal(second.state.codePreviewTimingEndedAt, undefined);
  second.update({ isPartial: false }, result("second-final"));
  assert.equal(scheduled.size, 0);
  assert.match(Arr.join(first.rows(), ""), /updated metadata/u);
  assert.match(Arr.join(second.rows(), ""), /second-final/u);
});

it.effect(
  "running icons animate with timing on or off and stop on settlement and scope cleanup",
  () =>
    Effect.gen(function* () {
      for (const timing of [true, false]) {
        let ticks = 0;
        const tickCount = () => ticks;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const scheduler = yield* CodePreviewSchedulerService;
            installCodePreviewSessionCapability({
              ...scheduler,
              run: () => Promise.reject(new Error("not used")),
            });
            yield* Effect.addFinalizer(() => Effect.sync(clearCodePreviewSessionCapability));
            const h = harness(summarize, "off", { timing });
            h.call({ invalidate: () => ticks++ });
            const pending = Arr.join(h.rows(), "");
            yield* TestClock.adjust(2 * SPINNER_FRAME_MS);
            assert.equal(tickCount(), 0);
            assert.equal(Arr.join(h.rows(), ""), pending);
            h.call({ executionStarted: true });
            const firstFrame = Arr.join(h.rows(), "");
            h.update({}, result(""));
            h.update({}, result(""));
            yield* TestClock.adjust(2 * SPINNER_FRAME_MS);
            assert.equal(tickCount(), 2, "repeated slot updates must share one animation timer");
            assert.notEqual(Arr.join(h.rows(), ""), firstFrame);
            if (!timing) {
              assert.equal(h.state.codePreviewTimingStartedAt, undefined);
              assert.doesNotMatch(Arr.join(h.rows(), ""), /\d+(?:ms|s)\b/u);
              h.update({ expanded: true });
              yield* TestClock.adjust(2 * SPINNER_FRAME_MS);
              assert.equal(tickCount(), 2);
              h.update({ expanded: false });
              yield* TestClock.adjust(SPINNER_FRAME_MS);
              assert.equal(tickCount(), 3);
            }
            h.update({ isPartial: false }, result("final"));
            const settledTicks = tickCount();
            const settled = Arr.join(h.rows(), "");
            yield* TestClock.adjust(500);
            assert.equal(tickCount(), settledTicks);
            assert.equal(Arr.join(h.rows(), ""), settled);
            const activeAtShutdown = harness(summarize, "off", { timing });
            activeAtShutdown.call({ executionStarted: true, invalidate: () => ticks++ });
            yield* TestClock.adjust(SPINNER_FRAME_MS);
            assert.equal(tickCount(), settledTicks + 1);
          }).pipe(provideBuiltLayer(CodePreviewSchedulerService.layer)),
        );
        const shutdownTicks = tickCount();
        yield* TestClock.adjust(500);
        assert.equal(tickCount(), shutdownTicks);
      }
    }),
);
