import assert from "node:assert/strict";
import {
  createReadToolDefinition,
  type ReadToolInput,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { afterEach, test } from "vitest";
import { BorderedToolCall } from "../../src/preview/bordered-tool-call";
import { createCodePreviewToolShell } from "../../src/preview/tool-shell";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { codePreviewSettings, setCodePreviewSettings } from "../../src/config/state";
import { renderComponent, testTheme } from "../../src/testing/render";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";
import type { ToolRenderContext } from "../../src/tools/renderers/shared/types";

const originalSettings = { ...codePreviewSettings, tools: [...codePreviewSettings.tools] };
const theme = testTheme();

type ReadDefinition = ReturnType<typeof createReadToolDefinition>;
type ReadRenderCall = NonNullable<ReadDefinition["renderCall"]>;
type ReadRenderResult = NonNullable<ReadDefinition["renderResult"]>;
type ReadResult = Parameters<ReadRenderResult>[0];
interface State {
  codePreviewTimingOnlyRenderToken?: number;
}

afterEach(() => setCodePreviewSettings(originalSettings));

function renderContext(
  args: ReadToolInput,
  state: State,
  overrides: Partial<ToolRenderContext<State, ReadToolInput>> = {},
): ToolRenderContext<State, ReadToolInput> {
  return {
    args,
    toolCallId: "tool-call",
    invalidate: () => undefined,
    lastComponent: undefined,
    state,
    cwd: "/project",
    executionStarted: false,
    argsComplete: true,
    isPartial: true,
    expanded: false,
    showImages: true,
    isError: false,
    ...overrides,
  };
}

function result(text: string): ReadResult {
  return { content: [{ type: "text", text }], details: undefined };
}

test("cooperative adapter forwards renderer values and preserves tool identity fields", () => {
  setCodePreviewSettings({ ...defaultCodePreviewSettings, toolCallTiming: false });
  const args: ReadToolInput = { path: "src/example.ts" };
  const state: State = {};
  const callLast = new Text("old call", 0, 0);
  const resultLast = new Text("old result", 0, 0);
  const resultValue = result("done");
  const resultOptions: ToolRenderResultOptions = { expanded: true, isPartial: false };
  const execute = () => Promise.resolve(resultValue);
  const parameters = createReadToolDefinition("/project").parameters;
  const promptGuidelines = ["Keep this metadata reference."];
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
    promptGuidelines,
    execute,
    renderCall,
    renderResult,
  };

  const wrapped = withCodePreviewShell(tool, { mode: "off" });
  const callContext = renderContext(args, state, { lastComponent: callLast });
  const renderedCall = wrapped.renderCall?.(args, theme, callContext);
  const resultContext = renderContext(args, state, {
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
  assert.equal(wrapped.promptGuidelines, promptGuidelines);
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
  setCodePreviewSettings({ ...defaultCodePreviewSettings, toolCallBackground: "off" });
  const captured = withCodePreviewShell(createReadToolDefinition("/project"));
  setCodePreviewSettings({ ...defaultCodePreviewSettings, toolCallBackground: "on" });
  assert.equal(captured.renderShell, "self");

  const context = renderContext({ path: "README.md" }, {});
  for (const [mode, expectedShell] of [
    ["on", "default"],
    ["off", "self"],
    ["border", "self"],
  ] as const) {
    const shell = createCodePreviewToolShell(mode);
    assert.equal(shell.renderShell, expectedShell);
    const component = shell.renderCall(context, theme, () => new Text(mode, 0, 0));
    assert.equal(component instanceof BorderedToolCall, mode === "border");
  }
});

test("border shell keeps independent last components for call and result slots", () => {
  setCodePreviewSettings({ ...defaultCodePreviewSettings, toolCallTiming: false });
  const shell = createCodePreviewToolShell("border");
  const args: ReadToolInput = { path: "README.md" };
  const state: State = {};
  const unrelated = new Text("unrelated", 0, 0);
  const callLast: Array<Component | undefined> = [];
  const resultLast: Array<Component | undefined> = [];
  const firstCallSlot = new Text("first call", 0, 0);
  const firstResultSlot = new Text("first result", 0, 0);
  shell.renderCall(renderContext(args, state, { lastComponent: unrelated }), theme, (context) => {
    callLast.push(context.lastComponent);
    return firstCallSlot;
  });
  shell.renderResult(
    renderContext(args, state, { isPartial: false, lastComponent: unrelated }),
    theme,
    (context) => {
      resultLast.push(context.lastComponent);
      return firstResultSlot;
    },
  );
  shell.renderCall(renderContext(args, state, { lastComponent: unrelated }), theme, (context) => {
    callLast.push(context.lastComponent);
    return new Text("second call", 0, 0);
  });
  shell.renderResult(
    renderContext(args, state, { isPartial: false, lastComponent: unrelated }),
    theme,
    (context) => {
      resultLast.push(context.lastComponent);
      return new Text("second result", 0, 0);
    },
  );

  assert.deepEqual(callLast, [undefined, firstCallSlot]);
  assert.deepEqual(resultLast, [undefined, firstResultSlot]);
});

test("fallback result rendering sanitizes terminal controls", () => {
  setCodePreviewSettings({ ...defaultCodePreviewSettings, toolCallTiming: false });
  const base = createReadToolDefinition("/project");
  const { renderCall: _renderCall, renderResult: _renderResult, ...withoutRenderers } = base;
  // SAFETY: The omitted optional renderers leave a valid Pi read definition for fallback testing.
  const tool = withoutRenderers as ReadDefinition;
  const wrapped = withCodePreviewShell(tool, { mode: "off" });
  const args: ReadToolInput = { path: "README.md" };
  const component = wrapped.renderResult?.(
    result("unsafe\u001b[2J\rtext"),
    { expanded: false, isPartial: false },
    theme,
    renderContext(args, {}, { isPartial: false, isError: true }),
  );

  assert.ok(component);
  const output = renderComponent(component);
  assert.equal(output.includes("\u001b"), false);
  assert.match(output, /unsafe␛\[2J␍text/);
});

test("shell reuses call and result slots without recomputing timing-only renders", () => {
  setCodePreviewSettings({ ...defaultCodePreviewSettings, toolCallTiming: true });
  const args: ReadToolInput = { path: "README.md" };
  const state: State = {};
  let calls = 0;
  let results = 0;
  const base = createReadToolDefinition("/project");
  const renderCall: ReadRenderCall = () => {
    calls++;
    return new Text(`call ${calls}`, 0, 0);
  };
  const renderResult: ReadRenderResult = () => {
    results++;
    return new Text(`result ${results}`, 0, 0);
  };
  const tool = { ...base, renderCall, renderResult };
  const wrapped = withCodePreviewShell(tool, { mode: "off" });
  const callContext = renderContext(args, state, { executionStarted: true });
  const firstCall = wrapped.renderCall?.(args, theme, callContext);
  const resultOptions = { expanded: false, isPartial: true };
  const resultContext = renderContext(args, state, { executionStarted: true });
  const firstResult = wrapped.renderResult?.(
    result("running"),
    resultOptions,
    theme,
    resultContext,
  );
  state.codePreviewTimingOnlyRenderToken = 1;

  const secondCall = wrapped.renderCall?.(args, theme, {
    ...callContext,
    lastComponent: firstCall,
  });
  const secondResult = wrapped.renderResult?.(result("running"), resultOptions, theme, {
    ...resultContext,
    lastComponent: firstResult,
  });

  assert.equal(calls, 1);
  assert.equal(results, 1);
  assert.equal(secondCall, firstCall);
  assert.ok(secondResult);
});
