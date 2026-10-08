import assert from "node:assert/strict";
import {
  createReadToolDefinition,
  type ReadToolInput,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  Text,
  getCapabilities,
  setCapabilities,
  type Component,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { createToolPresentationHarness, renderContextFixture } from "../../testing";
import { beforeEach, test } from "vitest";
import { createCodePreviewToolShell } from "../../src/preview/tool-shell";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import type { CodePreviewSettings } from "../../src/config/schema";
import { setCodePreviewSettings } from "../../src/config/state";
import { plainTheme as theme, renderComponent, textResult } from "../support/render";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";

const compactProvider = () => ({ subject: "compact-subject", outcome: "success" as const });
const previewShellOptions = { name: "read", compactSummary: () => undefined };

type ReadDefinition = ReturnType<typeof createReadToolDefinition>;
type ReadRenderCall = NonNullable<ReadDefinition["renderCall"]>;
type ReadRenderResult = NonNullable<ReadDefinition["renderResult"]>;
type ReadResult = Parameters<ReadRenderResult>[0];

/** Defaults without timing plus each test's overrides, so no test inherits another's settings. */
const settings = (overrides: Partial<CodePreviewSettings> = {}) =>
  setCodePreviewSettings({ ...defaultCodePreviewSettings, toolCallTiming: false, ...overrides });

beforeEach(() => settings());

test("cooperative adapter forwards renderer values and preserves tool identity fields", () => {
  const args: ReadToolInput = { path: "src/example.ts" };
  const state = {};
  const callLast = new Text("old call", 0, 0);
  const resultLast = new Text("old result", 0, 0);
  const resultValue = textResult("done");
  const resultOptions: ToolRenderResultOptions = { expanded: true, isPartial: false };
  const execute = () => Promise.resolve(resultValue);
  const parameters = createReadToolDefinition("/project").parameters;
  const prepareArguments: NonNullable<ReadDefinition["prepareArguments"]> = () => args;
  const promptGuidelines = ["Keep this metadata reference."];
  const constrainedSampling = { type: "json_schema", strict: "prefer" } as const;
  let observedCall: readonly unknown[] | undefined;
  let observedResult: readonly unknown[] | undefined;
  const callComponent = new Text("call", 0, 0);
  const resultComponent = new Text("result", 0, 0);
  const renderCall: ReadRenderCall = function (this: void, receivedArgs, receivedTheme, context) {
    assert.equal(this, undefined);
    observedCall = [receivedArgs, receivedTheme, context.state, context.lastComponent];
    return callComponent;
  };
  const renderResult: ReadRenderResult = function (
    this: void,
    receivedResult,
    receivedOptions,
    receivedTheme,
    context,
  ) {
    assert.equal(this, undefined);
    observedResult = [
      receivedResult,
      receivedOptions,
      receivedTheme,
      context.state,
      context.lastComponent,
    ];
    return resultComponent;
  };
  const tool = {
    ...createReadToolDefinition("/project"),
    name: "characterized",
    description: "characterized description",
    parameters,
    prepareArguments,
    promptGuidelines,
    constrainedSampling,
    execute,
    renderCall,
    renderResult,
  };

  const wrapped = withCodePreviewShell(tool, { mode: "off" });
  const callContext = renderContextFixture({ args, state, lastComponent: callLast });
  const renderedCall = wrapped.renderCall?.(args, theme, callContext);
  const resultContext = renderContextFixture({
    args,
    state,
    executionStarted: true,
    isPartial: false,
    expanded: true,
    lastComponent: resultLast,
  });
  const renderedResult = wrapped.renderResult?.(resultValue, resultOptions, theme, resultContext);

  assert.deepEqual(observedCall, [args, theme, state, callLast]);
  assert.deepEqual(observedResult, [resultValue, resultOptions, theme, state, resultLast]);
  assert.ok(renderedCall);
  assert.equal(renderedResult, resultComponent);
  assert.equal(wrapped.execute, execute);
  assert.equal(wrapped.parameters, parameters);
  assert.equal(wrapped.prepareArguments, prepareArguments);
  // Model-facing prompt metadata is optional on the definition, so TypeScript cannot prove it kept.
  assert.equal(wrapped.promptGuidelines, promptGuidelines);
  assert.equal(wrapped.constrainedSampling, constrainedSampling);
  assert.equal(wrapped.description, tool.description);
});

test("cooperative wrapper keeps self shells by identity unless override is requested", () => {
  const selfShell = { ...createReadToolDefinition("/project"), renderShell: "self" as const };

  assert.equal(withCodePreviewShell(selfShell), selfShell);
  const overridden = withCodePreviewShell(selfShell, {
    mode: "on",
    preserveSelfShell: false,
  });
  assert.notEqual(overridden, selfShell);
  assert.equal(overridden.renderShell, "default");
  assert.equal(overridden.execute, selfShell.execute);
});

test("cooperative wrapper captures mode and shell modes match on, off, and border", () => {
  settings({ toolCallBackground: "off" });
  const captured = withCodePreviewShell(createReadToolDefinition("/project"));
  settings({ toolCallBackground: "on" });
  assert.equal(captured.renderShell, "self");

  for (const [mode, expectedShell] of [
    ["on", "default"],
    ["off", "self"],
    ["border", "self"],
  ] as const)
    assert.equal(
      createCodePreviewToolShell(mode, previewShellOptions, false, "preview").renderShell,
      expectedShell,
    );
});

test("border shell keeps independent last components for call and result slots", () => {
  const shell = createCodePreviewToolShell("border", previewShellOptions, false, "preview");
  const args: ReadToolInput = { path: "README.md" };
  const state = {};
  const unrelated = new Text("unrelated", 0, 0);
  const callLast: Array<Component | undefined> = [];
  const resultLast: Array<Component | undefined> = [];
  const firstCallSlot = new Text("first call", 0, 0);
  const firstResultSlot = new Text("first result", 0, 0);
  const slotContext = (isPartial: boolean) =>
    renderContextFixture({ args, state, isPartial, lastComponent: unrelated });
  shell.renderCall(slotContext(true), theme, (context) => {
    callLast.push(context.lastComponent);
    return firstCallSlot;
  });
  shell.renderResult(
    slotContext(false),
    theme,
    (context) => {
      resultLast.push(context.lastComponent);
      return firstResultSlot;
    },
    textResult(""),
  );
  shell.renderCall(slotContext(true), theme, (context) => {
    callLast.push(context.lastComponent);
    return new Text("second call", 0, 0);
  });
  shell.renderResult(
    slotContext(false),
    theme,
    (context) => {
      resultLast.push(context.lastComponent);
      return new Text("second result", 0, 0);
    },
    textResult(""),
  );

  assert.deepEqual(callLast, [undefined, firstCallSlot]);
  assert.deepEqual(resultLast, [undefined, firstResultSlot]);
});

test("fallback result rendering sanitizes terminal controls", () => {
  const base = createReadToolDefinition("/project");
  const { renderCall: _renderCall, renderResult: _renderResult, ...withoutRenderers } = base;
  // SAFETY: The omitted optional renderers leave a valid Pi read definition for fallback testing.
  const tool = withoutRenderers as ReadDefinition;
  const wrapped = withCodePreviewShell(tool, { mode: "off" });
  const args: ReadToolInput = { path: "README.md" };
  const component = wrapped.renderResult?.(
    textResult("unsafe\u001b[2J\rtext"),
    { expanded: false, isPartial: false },
    theme,
    renderContextFixture({ args, isPartial: false, isError: true }),
  );

  assert.ok(component);
  const output = renderComponent(component);
  assert.equal(output.includes("\u001b"), false);
  assert.match(output, /unsafe␛\[2J␍text/);
});

test("preview shell does not hide semantic updates during timing invalidation", () => {
  settings({ toolCallTiming: true });
  const args: ReadToolInput = { path: "README.md" };
  for (const mode of ["off", "border"] as const) {
    const state = {};
    const tool = {
      ...createReadToolDefinition("/project"),
      renderCall: ((receivedArgs, _theme, _context) =>
        new Text(`call ${receivedArgs.path}`, 0, 0)) satisfies ReadRenderCall,
      renderResult: ((value, options, _theme, _context) =>
        new Text(
          `${options.expanded ? "expanded" : "collapsed"} ${value.content.map((part) => (part.type === "text" ? part.text : "")).join("")}`,
          0,
          0,
        )) satisfies ReadRenderResult,
    };
    const wrapped = withCodePreviewShell(tool, { mode });
    const context = renderContextFixture({ args, state, executionStarted: true });
    const firstCall = wrapped.renderCall(args, theme, context);
    const firstResult = wrapped.renderResult(
      textResult("old"),
      { expanded: false, isPartial: true },
      theme,
      context,
    );
    const nextArgs = { path: "changed.ts" };
    const secondCall = wrapped.renderCall(nextArgs, theme, {
      ...context,
      args: nextArgs,
      expanded: true,
      lastComponent: firstCall,
    });
    const secondResult = wrapped.renderResult(
      textResult("fresh"),
      { expanded: true, isPartial: true },
      theme,
      { ...context, args: nextArgs, expanded: true, lastComponent: firstResult },
    );
    const text = [...secondCall.render(100), ...secondResult.render(100)].join("\n");
    assert.match(text, /changed.ts/u);
    assert.match(text, /expanded fresh/u);
    assert.doesNotMatch(text, /old/u);
  }
});

test("tools without providers stay compact and retain domain failure output on expansion", () => {
  settings({ toolCallCollapsedStyle: "compact" });
  const tool = {
    ...createReadToolDefinition("/project"),
    renderResult: ((_value, _options, _theme, _context) =>
      new Text(
        "background work failed; inspect recovery receipt",
        0,
        0,
      )) satisfies ReadRenderResult,
  };
  const wrapped = withCodePreviewShell(tool, { mode: "off" });
  const context = renderContextFixture({ args: { path: "file" }, isPartial: false });
  const output = wrapped.renderResult(
    textResult("invocation completed"),
    { expanded: false, isPartial: false },
    theme,
    context,
  );
  assert.doesNotMatch(renderComponent(output), /background work failed/u);
  const expanded = wrapped.renderResult(
    textResult("invocation completed"),
    { expanded: true, isPartial: false },
    theme,
    { ...context, expanded: true },
  );
  assert.match(renderComponent(expanded), /background work failed; inspect recovery receipt/u);
});

test("compact style is captured and wraps self shells without changing execution", () => {
  const base = createReadToolDefinition("/project");
  const preview = withCodePreviewShell(base, { mode: "on", compactSummary: compactProvider });
  settings({ toolCallCollapsedStyle: "compact" });
  const compact = withCodePreviewShell(base, { mode: "on", compactSummary: compactProvider });
  const self = { ...base, renderShell: "self" as const };
  const wrappedSelf = withCodePreviewShell(self, { compactSummary: compactProvider });
  assert.notEqual(wrappedSelf, self);
  assert.equal(wrappedSelf.execute, self.execute);
  assert.equal(preview.renderShell, "default");
  assert.equal(compact.renderShell, "self");
  assert.equal(compact.execute, base.execute);
  assert.equal(compact.parameters, base.parameters);
  settings({ toolCallCollapsedStyle: "preview" });
  const context = renderContextFixture({ args: { path: "file" } });
  const component = compact.renderCall?.(context.args, theme, context);
  assert.ok(component);
  assert.match(renderComponent(component), /compact-subject/u);
});

test("preview timing toggles preserve producer caches and mouse actions", () => {
  for (const mode of ["on", "off"] as const) {
    const seen: TuiMouseEvent[] = [];
    const action = (text: string) =>
      Object.assign(new Text(text, 0, 0), {
        handleMouse(event: TuiMouseEvent) {
          seen.push(event);
          return { handled: true };
        },
      });
    const callText = action("call action");
    const resultText = action("result action\nsecond row");
    const tool = withCodePreviewShell(
      {
        ...createReadToolDefinition("/project"),
        renderCall: ((_args, _theme, ctx) => {
          // SAFETY: The producer owns this slot and only returns Text components.
          const text = (ctx.lastComponent as Text | undefined) ?? callText;
          text.setText("call action");
          assert.equal(text, callText);
          return text;
        }) satisfies ReadRenderCall,
        renderResult: ((_value, _options, _theme, ctx) => {
          // SAFETY: The producer owns this slot and only returns Text components.
          const text = (ctx.lastComponent as Text | undefined) ?? resultText;
          text.setText("result action\nsecond row");
          assert.equal(text, resultText);
          return text;
        }) satisfies ReadRenderResult,
      },
      { mode },
    );
    const h = createToolPresentationHarness(tool, {
      state: { codePreviewTimingStartedAt: 1000, codePreviewTimingEndedAt: 3379 },
    });
    const args = { path: "file" };
    const value = textResult("output");
    for (const timing of [true, false, true]) {
      settings({ toolCallTiming: timing });
      const call = h.call(args, { isPartial: false });
      const output = h.result(value);
      assert.ok(call && output);
      const callRows = call.render(80);
      const rows = output.render(80);
      assert.equal(
        rows.some((row) => row.includes("2.4s")),
        timing,
      );
      const event: TuiMouseEvent = {
        type: "click",
        button: "left",
        x: 0,
        y: 0,
        screenX: 0,
        screenY: 0,
        width: 80,
        height: callRows.length,
        shift: false,
        alt: false,
        ctrl: false,
      };
      assert.equal(call.handleMouse?.(event)?.handled, true);
      assert.equal(seen.at(-1)?.height, 1);
      assert.equal(output.handleMouse?.({ ...event, y: 1, height: rows.length })?.handled, true);
      assert.equal(seen.at(-1)?.height, 2);
      if (timing) {
        const count = seen.length;
        assert.equal(output.handleMouse?.({ ...event, y: 2, height: rows.length }), undefined);
        assert.equal(seen.length, count);
      }
      h.invalidate();
      assert.match(h.render().join("\n"), /result action/);
    }
  }
});

test("a display name heads compact rows without changing the registered tool name", () => {
  settings({ toolCallCollapsedStyle: "compact" });
  const base = { ...createReadToolDefinition("/project"), name: "registered_model_name" };
  const tool = withCodePreviewShell(base, {
    mode: "off",
    displayName: "shown-name",
    compactSummary: compactProvider,
  });
  assert.equal(tool.name, "registered_model_name");
  assert.equal(tool.execute, base.execute);
  const h = createToolPresentationHarness(tool);
  h.call({ path: "file" });
  h.result(textResult("done"));
  const text = h.render().join("\n");
  assert.match(text, /shown-name/u);
  assert.doesNotMatch(text, /registered_model_name/u);
});

test("fallback rendering preserves attachment evidence without taking native image ownership", () => {
  const caps = getCapabilities();
  try {
    for (const style of ["preview", "compact"] as const) {
      settings({ toolCallCollapsedStyle: style });
      const {
        renderCall: _call,
        renderResult: _result,
        ...source
      } = createReadToolDefinition("/project");
      const tool = withCodePreviewShell(source, { mode: "off" });
      for (const native of [false, true]) {
        setCapabilities({ ...caps, images: native ? "kitty" : null });
        for (const showImages of [false, true]) {
          for (const withText of [false, true]) {
            const value: ReadResult = {
              content: [
                ...(withText ? [{ type: "text" as const, text: "attachment context" }] : []),
                { type: "image", mimeType: "image/png", data: "unchanged-by-rendering" },
              ],
              details: undefined,
            };
            const before = JSON.stringify(value);
            const h = createToolPresentationHarness(tool);
            h.call({ path: "image.png" }, { expanded: true, showImages });
            h.result(value);
            const text = h.render().join("\n");
            assert.equal(text.includes("image/png"), !native || !showImages);
            assert.equal(text.includes("attachment context"), withText);
            assert.equal(text.includes("unchanged-by-rendering"), false);
            assert.equal(JSON.stringify(value), before);
            assert.equal(tool.execute, source.execute);
          }
        }
      }
    }
  } finally {
    setCapabilities(caps);
  }
});
