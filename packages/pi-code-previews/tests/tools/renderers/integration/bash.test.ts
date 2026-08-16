// Test/benchmark boundary intentionally exercises native Pi, Node, Promise, timer, and environment APIs.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/globalConsole:off
// @effect-diagnostics effect/globalDate:off
import assert from "node:assert/strict";
import { test } from "vitest";
import { defaultCodePreviewSettings } from "../../../../src/config/defaults";
import { setCodePreviewSettings } from "../../../../src/config/state";
import {
  cloneCodePreviewSettingsForTest,
  renderComponent,
  stripAnsi,
  testTheme,
} from "../../../../src/testing/render";
import {
  findRenderer,
  preserveCodePreviewToolsEnv,
  publishCodePreviewToolsEnvironment,
  registerRenderers,
} from "../../../../src/tools/renderers/testing";

preserveCodePreviewToolsEnv();

test("registered bash renderer can hide all successful output while preserving errors", () => {
  publishCodePreviewToolsEnvironment("bash");
  const previousSettings = cloneCodePreviewSettingsForTest();
  setCodePreviewSettings({ ...defaultCodePreviewSettings, bashResultPreview: false });
  try {
    const bash = findRenderer(registerRenderers(), "bash");
    assert.ok(bash.renderResult);

    const successCollapsed = stripAnsi(
      renderComponent(
        bash.renderResult(
          { content: [{ type: "text", text: "hidden output" }] },
          { expanded: false, isPartial: false },
          testTheme(),
          { args: { command: "npm test" }, isError: false, invalidate: () => undefined, state: {} },
        ),
      ),
    );
    assert.match(successCollapsed, /expand/);

    const successExpanded = stripAnsi(
      renderComponent(
        bash.renderResult(
          { content: [{ type: "text", text: "hidden output" }] },
          { expanded: true, isPartial: false },
          testTheme(),
          { args: { command: "npm test" }, isError: false, invalidate: () => undefined, state: {} },
        ),
      ),
    );
    assert.match(successExpanded, /hidden output/);

    const error = stripAnsi(
      renderComponent(
        bash.renderResult(
          { content: [{ type: "text", text: "failed output" }] },
          { expanded: true, isPartial: false },
          testTheme(),
          { args: { command: "npm test" }, isError: true, invalidate: () => undefined, state: {} },
        ),
      ),
    );
    assert.match(error, /failed output/);
  } finally {
    setCodePreviewSettings(previousSettings);
  }
});

test("registered bash renderer mutes successful output while preserving error color", () => {
  publishCodePreviewToolsEnvironment("bash");
  const bash = findRenderer(registerRenderers(), "bash");
  assert.ok(bash.renderResult);

  const coloredTheme = Object.assign(testTheme(), {
    fg: (key: string, text: string) =>
      ["muted", "error"].includes(key) ? `<${key}>${text}</${key}>` : text,
  });

  const success = renderComponent(
    bash.renderResult(
      { content: [{ type: "text", text: "ok" }] },
      { expanded: true, isPartial: false },
      coloredTheme,
      { args: {}, isError: false, invalidate: () => undefined, state: {} },
    ),
  );
  assert.equal(success.trimEnd(), "<muted>ok</muted>");

  const error = renderComponent(
    bash.renderResult(
      { content: [{ type: "text", text: "failed" }] },
      { expanded: true, isPartial: false },
      coloredTheme,
      { args: {}, isError: true, invalidate: () => undefined, state: {} },
    ),
  );
  assert.equal(error.trimEnd(), "<error>failed</error>");
});

test("registered bash renderer hides grep, find, and ls command output when matching previews are off", () => {
  publishCodePreviewToolsEnvironment("bash");
  const previousSettings = cloneCodePreviewSettingsForTest();
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    grepResultPreview: false,
    findResultPreview: false,
    lsResultPreview: false,
  });
  try {
    const bash = findRenderer(registerRenderers(), "bash");
    assert.ok(bash.renderResult);

    for (const command of [
      "grep -n TODO src/a.ts",
      "ls src/tools/renderers | head -5",
      "find src/tools/renderers -maxdepth 1 -name '*.ts'",
    ]) {
      const collapsed = stripAnsi(
        renderComponent(
          bash.renderResult(
            { content: [{ type: "text", text: "hidden output" }] },
            { expanded: false, isPartial: false },
            testTheme(),
            { args: { command }, isError: false, invalidate: () => undefined, state: {} },
          ),
        ),
      );
      assert.match(collapsed, /expand/);

      const expanded = stripAnsi(
        renderComponent(
          bash.renderResult(
            { content: [{ type: "text", text: "hidden output" }] },
            { expanded: true, isPartial: false },
            testTheme(),
            { args: { command }, isError: false, invalidate: () => undefined, state: {} },
          ),
        ),
      );
      assert.match(expanded, /hidden output/);
    }
  } finally {
    setCodePreviewSettings(previousSettings);
  }
});

test("registered bash renderer escapes terminal control characters in raw output", () => {
  publishCodePreviewToolsEnvironment("bash");
  const bash = findRenderer(registerRenderers(), "bash");
  assert.ok(bash.renderResult);

  const rendered = renderComponent(
    bash.renderResult(
      { content: [{ type: "text", text: "ok \x1b[31mred\x00" }] },
      { expanded: true, isPartial: false },
      testTheme(),
      { args: {}, isError: false, invalidate: () => undefined, state: {} },
    ),
  );
  assert.doesNotMatch(rendered, /\x1b\[31m/);
  assert.match(rendered, /␛\[31mred�/);
});

test("registered bash renderer preserves whitespace-sensitive output", () => {
  publishCodePreviewToolsEnvironment("bash");
  const bash = findRenderer(registerRenderers(), "bash");
  assert.ok(bash.renderResult);

  const output = renderComponent(
    bash.renderResult(
      { content: [{ type: "text", text: "  indented\n" }] },
      { expanded: true, isPartial: false },
      testTheme(),
      { args: {}, isError: false, invalidate: () => undefined, state: {} },
    ),
    "  indented".length,
  );
  assert.equal(stripAnsi(output), "  indented");

  const blankOutput = stripAnsi(
    renderComponent(
      bash.renderResult(
        { content: [{ type: "text", text: "   \n" }] },
        { expanded: true, isPartial: false },
        testTheme(),
        { args: {}, isError: false, invalidate: () => undefined, state: {} },
      ),
    ),
  );
  assert.doesNotMatch(blankOutput, /No output/);
});
