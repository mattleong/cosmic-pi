import assert from "node:assert/strict";
import {
  createReadToolDefinition,
  type ReadToolInput,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createToolPresentationHarness, renderContextFixture } from "../../testing";
import { beforeEach, test } from "vitest";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import type { CodePreviewSettings } from "../../src/config/schema";
import { setCodePreviewSettings } from "../../src/config/state";
import { plainTheme as theme, renderComponent, textResult } from "../support/render";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";
import { executeDescriptor } from "../support/tool-identity";

const compactProvider = () => ({ subject: "compact-subject", outcome: "success" as const });

type ReadDefinition = ReturnType<typeof createReadToolDefinition>;
type ReadRenderCall = NonNullable<ReadDefinition["renderCall"]>;
type ReadRenderResult = NonNullable<ReadDefinition["renderResult"]>;

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
  assert.equal(wrapped.promptGuidelines, promptGuidelines);
  assert.equal(wrapped.constrainedSampling, constrainedSampling);
  assert.equal(wrapped.description, tool.description);
});

test("fallback result rendering sanitizes terminal controls", () => {
  const base = createReadToolDefinition("/project");
  const { renderCall: _renderCall, renderResult: _renderResult, ...withoutRenderers } = base;
  const tool: ReadDefinition = withoutRenderers;
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

test("a display name heads compact rows without changing the registered tool name", () => {
  settings({ toolCallCollapsedStyle: "compact" });
  const base = { ...createReadToolDefinition("/project"), name: "registered_model_name" };
  const tool = withCodePreviewShell(base, {
    mode: "off",
    displayName: "shown-name",
    compactSummary: compactProvider,
  });
  assert.equal(tool.name, "registered_model_name");
  assert.deepEqual(executeDescriptor(tool), executeDescriptor(base));
  const h = createToolPresentationHarness(tool);
  h.call({ path: "file" });
  h.result(textResult("done"));
  const text = h.render().join("\n");
  assert.match(text, /shown-name/u);
  assert.doesNotMatch(text, /registered_model_name/u);
});
