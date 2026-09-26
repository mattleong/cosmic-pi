import assert from "node:assert/strict";
import { createReadToolDefinition, type ReadToolInput } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { provideBuiltLayer } from "pi-cosmic-core";
import { applyPresentationSettings, renderContextFixture } from "../../testing";
import { CodePreviewSchedulerService } from "../../src/application/scheduler";
import {
  clearCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
} from "../../src/application/capability";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import type { ToolCallBackgroundMode, ToolCallCollapsedStyle } from "../../src/config/schema";
import { codePreviewSettings, setCodePreviewSettings } from "../../src/config/state";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";
import { claimCompactIssue } from "../../src/tools/compact-issues";
import type {
  CompactAnimationScheduler,
  CompactSummary,
  CompactSummaryProvider,
} from "../../src/tools/compact-summary";
import type { ToolRenderContext } from "../../src/tools/renderers/shared/types";
import { failingRenderer, plainTheme, textResult as result } from "../support/render";

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
  value?.content.map((part) => (part.type === "text" ? part.text : "")).join("\n") ?? "";
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
  assert.match(h.rows().join(""), /final-count/u);
  assert.doesNotMatch(h.rows().join(""), /stream-one/u);
  assert.equal(bodyWork, 0, "compact summaries must avoid hidden diff/output computation");
});

test("nested calls render once in the collapsed shell and yield to expanded details", () => {
  const h = harness((input) => ({
    ...summarize(input),
    subject: "Inspect",
    children: {
      entries: [{ label: "CHILD_CALL", status: input.phase === "settled" ? "success" : "running" }],
      total: 1,
    },
  }));
  h.call({ executionStarted: true });
  h.result(result("stream"));
  assert.equal(
    h
      .rows()
      .join("\n")
      .match(/CHILD_CALL/gu)?.length,
    1,
  );
  const settled = h.update({ isPartial: false }, result("final"));
  assert.equal(settled.join("\n").match(/CHILD_CALL/gu)?.length, 1);
  const expanded = h.update({ expanded: true });
  assert.doesNotMatch(expanded.join("\n"), /CHILD_CALL/u);
  assert.match(expanded.join("\n"), /BODY final/u);
  const collapsed = h.update({ expanded: false });
  assert.equal(collapsed.join("\n").match(/CHILD_CALL/gu)?.length, 1);
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
  assert.match(h.rows().join(""), /recorded-final/u);
  assert.equal(h.state.codePreviewTimingStartedAt, undefined);
  assert.equal(h.state.codePreviewTimingEndedAt, undefined);
});

test("expansion in each background mode restores both bodies exactly once and keeps slot-local last components", () => {
  for (const mode of ["on", "off", "border"] as const) {
    const callLast: Array<Component | undefined> = [];
    const resultLast: Array<Component | undefined> = [];
    const callBody = new Text("CALL detail", 0, 0);
    const resultBody = new Text("RESULT detail", 0, 0);
    const h = harness(summarize, mode, {
      call: (_args, _theme, context) => {
        callLast.push(context.lastComponent);
        return callBody;
      },
      result: (_result, _options, _theme, context) => {
        resultLast.push(context.lastComponent);
        return resultBody;
      },
    });
    h.update({ isPartial: false }, result("final"));
    const expanded = h.update({ expanded: true }).join("\n");
    assert.equal(expanded.match(/CALL detail/gu)?.length, 1);
    assert.equal(expanded.match(/RESULT detail/gu)?.length, 1);
    assert.deepEqual(callLast, [undefined]);
    assert.deepEqual(resultLast, [undefined]);
    h.update({ expanded: false });
    assert.equal(h.rows().length, 1);
    h.update({ expanded: true });
    assert.deepEqual(callLast, [undefined, callBody]);
    assert.deepEqual(resultLast, [undefined, resultBody]);
    assert.equal(h.tool.renderShell, "self");
  }
});

test("result-only rendering stays visible and is not duplicated when a call slot later mounts", () => {
  const h = harness();
  const orphan = h.result(result("orphan"), { isPartial: false });
  assert.match(orphan.render(100).join(""), /orphan/u);
  h.call();
  assert.deepEqual(orphan.render(100), []);
  assert.equal(h.rows().length, 1);
  assert.match(h.rows().join(""), /orphan/u);
  h.update({ expanded: true });
  assert.equal(
    h
      .rows()
      .join("\n")
      .match(/BODY orphan/gu)?.length,
    1,
  );
});

test("missing outcomes, declines and throwing providers keep domain failure bodies on expansion", () => {
  const body = Array.from({ length: 100 }, (_, index) => `recovery-step-${index}`).join("\n");
  for (const mode of ["on", "off", "border"] as const) {
    for (const provider of [
      () => undefined,
      () => ({ subject: "subject" }),
      () => {
        throw new Error("summary failure");
      },
    ] satisfies Provider[]) {
      const h = harness(provider, mode);
      h.update({ isPartial: false }, result(body));
      assert.doesNotMatch(h.rows().join("\n"), /CALL file.ts|recovery-step/u);
      const expanded = h.update({ expanded: true }).join("\n");
      assert.match(expanded, /CALL file.ts/u);
      for (const step of body.split("\n")) assert.ok(expanded.includes(step));
    }
  }
});

test("errors, cancellation and uncertainty retain full notices and original details even when expanded", () => {
  for (const mode of ["on", "off", "border"] as const) {
    for (const outcome of ["error", "cancelled", "uncertain"] as const) {
      const h = harness(
        ({ args }) => ({
          subject: args.path ?? "",
          outcome,
          notices: [{ kind: "recovery", text: "line-one\nline-two recovery command" }],
        }),
        mode,
      );
      h.update({ isPartial: false }, result("rich failure body"));
      for (const expanded of [false, true, false, true]) {
        const text = h.update({ expanded }).join("\n");
        assert.equal(text.includes("rich failure body"), expanded);
        assert.equal(text.includes("line-two recovery command"), expanded);
        assert.equal(text.includes("CALL file.ts"), expanded);
      }
    }
  }
  const h = harness(summarize);
  h.update({ isError: true, isPartial: false }, result("aborted before execution"));
  assert.match(h.update({ expanded: true }).join("\n"), /aborted before execution/u);
});

test("covered cancellation keeps its classification regardless of the host error flag", () => {
  const summary: CompactSummary = { subject: "file.ts", outcome: "cancelled" };
  const provider: Provider = () => summary;
  const ordinary = harness(provider);
  const hostError = harness(provider);
  const value = result("Cancellation diagnostics");
  const expected = ordinary.update({ isPartial: false, isError: false }, value);
  const actual = hostError.update({ isPartial: false, isError: true }, value);
  assert.deepEqual(actual, expected);
  assert.equal(actual.length, 1, "known cancellation needs no synthetic warning or error");
  assert.match(hostError.update({ expanded: true }).join("\n"), /Cancellation diagnostics/u);
});

test("legacy owned failures retain unclassified recovery without text-based suppression", () => {
  for (const outcome of ["error", "cancelled", "uncertain"] as const) {
    for (const mode of ["on", "off", "border"] as const) {
      const h = harness(
        () => ({
          subject: "file.ts",
          outcome,
          failure: {
            cause: "short cause",
            description: "short cause",
            details: "complete diagnostic\nInspect before retrying.",
          },
          notices: [
            { kind: "recovery", text: "Inspect before retrying." },
            {
              kind: "warning",
              text: "Independent safety warning",
              description: "Independent safety warning",
            },
          ],
        }),
        mode,
      );
      // A restored failure can mount its result slot before the call slot exists.
      const orphan = h.result(result("original renderer detail"), {
        isPartial: false,
        isError: true,
      });
      assert.match(orphan.render(100).join("\n"), /short cause/u);
      h.call();
      assert.deepEqual(orphan.render(100), []);
      for (const expanded of [false, true, false, true]) {
        const text = h.update({ expanded }).join("\n");
        assert.doesNotMatch(text, /CALL |BODY |original renderer detail/u);
        assert.equal(text.match(/file\.ts/gu)?.length, 1);
        assert.equal(text.match(/Inspect before retrying\./gu)?.length ?? 0, expanded ? 2 : 0);
        assert.match(text, /Independent safety warning/u);
        if (expanded) {
          assert.match(text, /complete diagnostic/u);
          assert.doesNotMatch(text, /short cause/u);
        } else {
          assert.match(text, /short cause/u);
          assert.doesNotMatch(text, /complete diagnostic/u);
        }
      }
    }
  }
});

test("warnings remain visible while normal live output stays hidden", () => {
  const h = harness(({ args }) => ({
    subject: args.path ?? "",
    notices: [{ kind: "warning", text: "secret detected", description: "secret detected" }],
  }));
  h.update({ executionStarted: true }, result("ordinary live output"));
  assert.match(h.rows().join("\n"), /secret detected/u);
  assert.doesNotMatch(h.rows().join("\n"), /ordinary live output/u);
});

test("lazy original renderer exceptions use per-slot fallback instead of escaping component render", () => {
  for (const expanded of [false, true]) {
    const broken = failingRenderer("factory");
    const h = harness(() => undefined, "off", { call: broken, result: broken });
    h.update(
      { expanded, isPartial: false, isError: true },
      result("all raw error details\nrecover here\u001b[2J"),
    );
    const text = h.rows().join("\n");
    assert.match(text, /read/u);
    assert.equal(text.includes("all raw error details"), expanded);
    assert.equal(text.includes("recover here"), expanded);
    assert.equal(text.includes("\u001b"), false);
  }
});

test("expanded ownership survives neither factory nor component rendering failure", () => {
  for (const mode of ["on", "off", "border"] as const) {
    for (const failure of ["factory", "draw"] as const) {
      const h = harness(
        () => ({
          subject: "file.ts",
          outcome: "warning",
          detailsOnExpand: true,
          expandedResultOwnsCall: true,
          issues: {
            coverage: "complete",
            entries: [
              {
                operation: "read-1",
                code: "cleanup",
                severity: "warning",
                cause: "Cleanup is unconfirmed.",
                recovery: [{ code: "inspect", text: "Inspect state before retrying." }],
              },
            ],
          },
        }),
        mode,
        { result: failingRenderer(failure) },
      );
      const rows = h.update(
        { expanded: true, isPartial: false },
        result("raw diagnostic retained"),
      );
      const text = rows.join("\n");
      assert.match(text, /raw diagnostic retained/u);
      assert.match(text, /Cleanup is unconfirmed\./u);
      assert.match(text, /Inspect state before retrying\./u);
    }
  }
});

test("unknown coverage transfers individual issues but never whole-call ownership", () => {
  for (const failure of ["none", "factory", "draw"] as const) {
    const h = harness(
      () => ({
        subject: "file.ts",
        outcome: "error",
        expandedResultOwnsCall: true,
        expandedResultOwnsIssues: [
          claimCompactIssue(
            {
              operation: "read-1",
              code: "owned",
              severity: "error",
              cause: "Owned cause",
              recovery: [],
            },
            { cause: true },
          ),
        ],
        issues: {
          coverage: "unknown",
          entries: [
            {
              operation: "read-1",
              code: "owned",
              severity: "error",
              cause: "Owned cause",
              recovery: [],
            },
            {
              operation: "read-1",
              code: "independent",
              severity: "warning",
              cause: "Independent recovery",
              description: "Independent recovery",
              recovery: [],
            },
          ],
        },
      }),
      "off",
      { result: failingRenderer(failure, ["Owned cause", "Original diagnostics"]) },
    );
    for (const expanded of [false, true, false]) {
      const text = h
        .update({ expanded, isPartial: false }, result("Fallback diagnostics"))
        .join("\n");
      assert.equal(text.split("Owned cause").length - 1, expanded ? 1 : 0);
      assert.match(text, /Independent recovery/u);
      assert.equal(text.includes("CALL file.ts"), expanded);
      if (expanded) {
        assert.ok(text.includes("file.ts"));
        assert.ok(
          text.includes(failure === "none" ? "Original diagnostics" : "Fallback diagnostics"),
        );
      }
    }
  }
});

test("incomplete and malformed evidence stays compact with original details on expansion", () => {
  for (const malformed of [false, true]) {
    const summary: CompactSummary = {
      subject: "file.ts",
      outcome: "error",
      detailsOnExpand: true,
      expandedResultOwnsCall: true,
      issues: {
        coverage: "unknown",
        entries: [
          {
            operation: "read-1",
            code: "incomplete",
            severity: "warning",
            cause: "Additional recovery unavailable.",
            recovery: [],
          },
        ],
      },
    };
    if (malformed)
      Reflect.set(summary, "issues", { coverage: "complete", entries: [{ severity: "error" }] });
    const h = harness(() => summary);
    const rows = h.update({ isPartial: false }, result("complete original recovery"));
    assert.doesNotMatch(rows.join("\n"), /complete original recovery/u);
    assert.match(h.update({ expanded: true }).join("\n"), /complete original recovery/u);
  }
});

test("expansion, arguments, result and error changes are not hidden by a timing token", () => {
  const h = harness();
  h.update({ executionStarted: true }, result("old"));
  h.state.codePreviewTimingOnlyRenderToken = 1;
  const expanded = h
    .update({ expanded: true, args: { path: "new.ts" } }, result("new-result"))
    .join("\n");
  assert.match(expanded, /CALL new.ts/u);
  assert.match(expanded, /BODY new-result/u);
  assert.doesNotMatch(expanded, /BODY old/u);
  h.update({ expanded: false, isError: true, isPartial: false }, result("new-error"));
  assert.match(h.rows().join("\n"), /new-error/u);
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
  assert.match(first.rows().join(""), /updated metadata/u);
  assert.match(second.rows().join(""), /second-final/u);
});

test("the timing preference gates overall and nested measured durations together", () => {
  for (const timing of [false, true]) {
    const h = harness(
      (input) => ({
        ...summarize(input),
        subject: "Inspect",
        showTiming: true,
        counters: ["3 tools"],
        children: {
          entries: [
            { label: "nested-read", status: "success", showTiming: true, durationMs: 1500 },
          ],
          total: 1,
        },
      }),
      "off",
      { timing },
    );
    h.state.codePreviewTimingStartedAt = 100;
    h.state.codePreviewTimingEndedAt = 350;
    h.call({ isPartial: false });
    h.result(result("done"), { isPartial: false });
    const rendered = h.rows().join("\n");
    assert.ok(rendered.includes("3 tools"));
    assert.equal(rendered.includes("250ms"), timing);
    assert.equal(rendered.includes("1.5s"), timing);
  }
});

test("enabling duration display at settlement still cancels an animation-only timer", () => {
  const scheduled = installRecordingScheduler();
  const h = harness(summarize, "off", { timing: false });
  h.call({ executionStarted: true });
  assert.equal(scheduled.size, 1);
  assert.equal(h.state.codePreviewTimingStartedAt, undefined);
  setCodePreviewSettings({ ...codePreviewSettings, toolCallTiming: true });
  h.update({ isPartial: false }, result("final"));
  assert.equal(scheduled.size, 0);
  assert.equal(h.state.codePreviewTimingStartedAt, undefined);
});

test("theme invalidation reaches retained detail components even while collapsed", () => {
  let value = "old-theme";
  let cached: string | undefined;
  const body: Component = {
    render: () => [(cached ??= value)],
    invalidate: () => {
      cached = undefined;
    },
  };
  const h = harness(summarize, "off", { call: () => body });
  const shell = h.call({ expanded: true });
  assert.match(h.rows().join(""), /old-theme/u);
  h.update({ expanded: false });
  value = "new-theme";
  h.state.codePreviewTimingOnlyRenderToken = 1;
  shell.invalidate();
  assert.match(h.update({ expanded: true }).join(""), /new-theme/u);
});

it.effect("cooperative animation uses its injected owner without a previews runtime", () =>
  Effect.gen(function* () {
    clearCodePreviewSessionCapability();
    for (const timing of [false, true]) {
      let ticks = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const scheduler = yield* CodePreviewSchedulerService;
          const provider: Provider = (input) => ({
            ...summarize(input),
            subject: input.args.path ?? "",
            notices:
              textOf(input.result) === "1/2"
                ? [
                    {
                      kind: "warning",
                      text: "Inspect partial side effects",
                      description: "Partial changes may remain",
                    },
                  ]
                : [],
          });
          const h = harness(provider, "off", { timing, scheduleAnimation: scheduler.schedule });
          h.update({ executionStarted: true, invalidate: () => ticks++ }, result("0/2"));
          const initial = h.rows(240).join("\n");
          let previous = initial;
          for (let frame = 0; frame < 2; frame++) {
            yield* TestClock.adjust(100);
            const current = h.rows(240).join("\n");
            assert.notEqual(current, previous);
            if (!timing) {
              // Ignore the activity token without coupling the test to its glyph or color.
              assert.equal(current.replace(/^\S+/u, ""), initial.replace(/^\S+/u, ""));
            }
            previous = current;
          }
          assert.equal(ticks, 2);
          if (!timing) {
            h.update({}, result("1/2"));
            const progress = h.rows(240);
            assert.equal(progress[0]?.replace("1/2", "0/2"), previous.split("\n")[0]);
            assert.match(progress.join("\n"), /Partial changes may remain/u);
            h.call({ args: { path: "updated-file.ts" } });
            const streamed = h.rows(240);
            assert.equal(streamed[0]?.replace("updated-file.ts", "file.ts"), progress[0]);
            assert.deepEqual(streamed.slice(1), progress.slice(1));
          }
          h.update({ isPartial: false }, result("done"));
          yield* TestClock.adjust(200);
          assert.equal(ticks, 2);
          const active = harness(summarize, "off", {
            timing,
            scheduleAnimation: scheduler.schedule,
          });
          active.call({ executionStarted: true, invalidate: () => ticks++ });
          yield* TestClock.adjust(100);
          assert.equal(ticks, 3);
        }).pipe(provideBuiltLayer(CodePreviewSchedulerService.layer)),
      );
      yield* TestClock.adjust(200);
      assert.equal(ticks, 3, "owner shutdown must stop cooperative animation");
    }
  }),
);

it.effect("preview-style duration refresh also uses the injected session scheduler", () =>
  Effect.scoped(
    Effect.gen(function* () {
      clearCodePreviewSessionCapability();
      const scheduler = yield* CodePreviewSchedulerService;
      for (const mode of ["on", "off", "border"] as const) {
        let ticks = 0;
        const h = harness(summarize, mode, {
          style: "preview",
          timing: true,
          scheduleAnimation: scheduler.schedule,
        });
        h.update({ executionStarted: true, invalidate: () => ticks++ }, result("live output"));
        yield* TestClock.adjust(200);
        assert.equal(ticks, 2);
        h.update({ isPartial: false }, result("done"));
        yield* TestClock.adjust(200);
        assert.equal(ticks, 2);
      }
    }).pipe(provideBuiltLayer(CodePreviewSchedulerService.layer)),
  ),
);

test("an unavailable scheduler is not cached as an active animation", () => {
  clearCodePreviewSessionCapability();
  let available = false;
  let scheduled = 0;
  const h = harness(summarize, "off", {
    scheduleAnimation: () => {
      if (!available) return undefined;
      scheduled++;
      return () => undefined;
    },
  });
  h.call({ executionStarted: true });
  assert.equal(scheduled, 0);
  available = true;
  h.call();
  assert.equal(scheduled, 1);
  h.update({ isPartial: false }, result("done"));
});

it.effect(
  "running icons animate with timing on or off and stop on settlement and scope cleanup",
  () =>
    Effect.gen(function* () {
      for (const timing of [true, false]) {
        let ticks = 0;
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
            const pending = h.rows().join("");
            yield* TestClock.adjust(200);
            assert.equal(ticks, 0);
            assert.equal(h.rows().join(""), pending);
            h.call({ executionStarted: true });
            const firstFrame = h.rows().join("");
            h.update({}, result(""));
            h.update({}, result(""));
            yield* TestClock.adjust(200);
            assert.equal(ticks, 2, "repeated slot updates must share one animation timer");
            assert.notEqual(h.rows().join(""), firstFrame);
            if (!timing) {
              assert.equal(h.state.codePreviewTimingStartedAt, undefined);
              assert.doesNotMatch(h.rows().join(""), /\d+(?:ms|s)\b/u);
              h.update({ expanded: true });
              yield* TestClock.adjust(200);
              assert.equal(ticks, 2);
              h.update({ expanded: false });
              yield* TestClock.adjust(100);
              assert.equal(ticks, 3);
            }
            h.update({ isPartial: false }, result("final"));
            const settledTicks = ticks;
            const settled = h.rows().join("");
            yield* TestClock.adjust(500);
            assert.equal(ticks, settledTicks);
            assert.equal(h.rows().join(""), settled);
            const activeAtShutdown = harness(summarize, "off", { timing });
            activeAtShutdown.call({ executionStarted: true, invalidate: () => ticks++ });
            yield* TestClock.adjust(100);
            assert.equal(ticks, settledTicks + 1);
          }).pipe(provideBuiltLayer(CodePreviewSchedulerService.layer)),
        );
        const shutdownTicks = ticks;
        yield* TestClock.adjust(500);
        assert.equal(ticks, shutdownTicks);
      }
    }),
);
