// Test/benchmark boundary intentionally exercises native Pi, Node, Promise, timer, and environment APIs.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/globalConsole:off
// @effect-diagnostics effect/globalDate:off
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { codePreviewSettings, setCodePreviewSettings } from "../../../../src/settings/index";
import {
  cloneCodePreviewSettingsForTest,
  createToolRenderContext,
  renderComponent,
  stripAnsi,
  testTheme,
} from "../../../../src/testing/render";
import {
  findRenderer,
  preserveCodePreviewToolsEnv,
  registerRenderers,
} from "../../../../src/tools/renderers/testing";

preserveCodePreviewToolsEnv();

test("registered edit call previews proposed edits before execution", () => {
  process.env.CODE_PREVIEW_TOOLS = "edit";
  const edit = findRenderer(registerRenderers(), "edit");
  assert.ok(edit.renderCall);
  const args = {
    path: "src/a.ts",
    edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }],
  };
  const state = {};
  const pendingComponent = edit.renderCall(args, testTheme(), createToolRenderContext({ state }));
  const rendered = stripAnsi(renderComponent(pendingComponent));
  assert.match(rendered, /edit src\/a\.ts/);
  assert.match(rendered, /proposed edit/);
  assert.match(rendered, /const value = 1;/);
  assert.match(rendered, /const value = 2;/);

  const started = stripAnsi(
    renderComponent(
      edit.renderCall(
        args,
        testTheme(),
        createToolRenderContext({
          executionStarted: true,
          lastComponent: pendingComponent,
          state,
        }),
      ),
    ),
  );
  assert.match(started, /edit src\/a\.ts/);
  assert.doesNotMatch(started, /proposed edit/);
});

test("registered edit timing measures execution start to result completion", () => {
  process.env.CODE_PREVIEW_TOOLS = "edit";
  const previousSettings = cloneCodePreviewSettingsForTest();
  setCodePreviewSettings({
    ...codePreviewSettings,
    toolCallBackground: "on",
    toolCallTiming: true,
  });
  try {
    const edit = findRenderer(registerRenderers(), "edit");
    assert.ok(edit.renderCall);
    assert.ok(edit.renderResult);

    const args = {
      path: "src/a.ts",
      edits: [{ oldText: "old", newText: "new" }],
    };
    const state = {};
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    edit.renderCall(args, testTheme(), createToolRenderContext({ executionStarted: true, state }));

    vi.mocked(Date.now).mockReturnValue(3_120);
    const result = edit.renderResult(
      {
        content: [{ type: "text", text: "ok" }],
        details: { diff: "-old\n+new" },
      },
      { expanded: true, isPartial: false },
      testTheme(),
      createToolRenderContext({ args, executionStarted: true, isPartial: false, state }),
    );

    assert.match(stripAnsi(renderComponent(result)), /╰─ Took 2\.1s/);
  } finally {
    vi.restoreAllMocks();
    setCodePreviewSettings(previousSettings);
  }
});

test("registered write renderer hides code previews until expanded", () => {
  process.env.CODE_PREVIEW_TOOLS = "write";
  const previousSettings = cloneCodePreviewSettingsForTest();
  setCodePreviewSettings({ ...codePreviewSettings, writeContentPreview: false });
  try {
    const write = findRenderer(registerRenderers(), "write");
    assert.ok(write.renderCall);
    assert.ok(write.renderResult);

    const args = { path: "src/a.ts", content: "const after = 2;\n" };
    const collapsedCall = stripAnsi(
      renderComponent(
        write.renderCall(args, testTheme(), createToolRenderContext({ expanded: false })),
      ),
    );
    assert.match(collapsedCall, /write src\/a\.ts/);
    assert.match(collapsedCall, /expand/);
    assert.doesNotMatch(collapsedCall, /output hidden/);
    assert.doesNotMatch(collapsedCall, /const after = 2/);

    const expandedCall = stripAnsi(
      renderComponent(write.renderCall(args, testTheme(), createToolRenderContext())),
    );
    assert.match(expandedCall, /const after = 2/);

    const collapsedResult = stripAnsi(
      renderComponent(
        write.renderResult(
          {
            content: [{ type: "text", text: "ok" }],
            details: {
              codePreviewBeforeWrite: { kind: "content", content: "const before = 1;\n" },
            },
          },
          { expanded: false, isPartial: false },
          testTheme(),
          createToolRenderContext({ args }),
        ),
      ),
    );
    assert.match(collapsedResult, /✓ Write applied/);
    assert.match(collapsedResult, /expand/);
    assert.doesNotMatch(collapsedResult, /output hidden/);
    assert.doesNotMatch(collapsedResult, /const after = 2/);

    const newFileCollapsedResult = stripAnsi(
      renderComponent(
        write.renderResult(
          {
            content: [{ type: "text", text: "ok" }],
            details: { codePreviewBeforeWrite: { kind: "missing" } },
          },
          { expanded: false, isPartial: false },
          testTheme(),
          createToolRenderContext({ args }),
        ),
      ),
    );
    assert.match(newFileCollapsedResult, /✓ New file/);
    assert.doesNotMatch(newFileCollapsedResult, /output hidden/);

    const expandedResult = stripAnsi(
      renderComponent(
        write.renderResult(
          {
            content: [{ type: "text", text: "ok" }],
            details: {
              codePreviewBeforeWrite: { kind: "content", content: "const before = 1;\n" },
            },
          },
          { expanded: true, isPartial: false },
          testTheme(),
          createToolRenderContext({ args }),
        ),
      ),
    );
    assert.match(expandedResult, /const after = 2/);
  } finally {
    setCodePreviewSettings(previousSettings);
  }
});

test("registered write renderer does not label redacted previous content as a new file", () => {
  process.env.CODE_PREVIEW_TOOLS = "write";
  const write = findRenderer(registerRenderers(), "write");
  assert.ok(write.renderResult);

  const rendered = stripAnsi(
    renderComponent(
      write.renderResult(
        {
          content: [{ type: "text", text: "ok" }],
          details: { codePreviewBeforeWrite: { kind: "content", byteLength: 6 } },
        },
        { expanded: true, isPartial: false },
        testTheme(),
        createToolRenderContext({
          args: { path: "src/a.ts", content: "after" },
          toolCallId: "tool-redacted-missing-cache",
        }),
      ),
    ),
  );

  assert.match(rendered, /previous content unavailable/);
  assert.doesNotMatch(rendered, /New file/);
});

test("registered write renderer distinguishes blank-only content from empty content", () => {
  process.env.CODE_PREVIEW_TOOLS = "write";
  const write = findRenderer(registerRenderers(), "write");
  assert.ok(write.renderCall);

  const rendered = stripAnsi(
    renderComponent(
      write.renderCall(
        { path: "blank.txt", content: "\n\n" },
        testTheme(),
        createToolRenderContext(),
      ),
    ),
  );

  assert.doesNotMatch(rendered, /Empty content/);
  assert.match(rendered, /1 line/);
});

test("registered write result diffs use and invalidate on the write line limit", () => {
  process.env.CODE_PREVIEW_TOOLS = "write";
  const previousSettings = cloneCodePreviewSettingsForTest();
  const write = findRenderer(registerRenderers(), "write");
  assert.ok(write.renderResult);
  const before = Array.from({ length: 8 }, (_, index) => `before ${index}`).join("\n");
  const after = Array.from({ length: 8 }, (_, index) => `after ${index}`).join("\n");
  const args = { path: "notes.txt", content: after };
  const result = {
    content: [{ type: "text", text: "ok" }],
    details: { codePreviewBeforeWrite: { kind: "content", content: before } },
  };
  const state = {};

  try {
    setCodePreviewSettings({
      ...codePreviewSettings,
      editCollapsedLines: "all",
      writeCollapsedLines: 2,
    });
    const first = stripAnsi(
      renderComponent(
        write.renderResult(
          result,
          { expanded: false, isPartial: false },
          testTheme(),
          createToolRenderContext({ args, expanded: false, state }),
        ),
      ),
    );
    assert.match(first, /Showing 2 of \d+ diff lines/);

    setCodePreviewSettings({ ...codePreviewSettings, writeCollapsedLines: 4 });
    const second = stripAnsi(
      renderComponent(
        write.renderResult(
          result,
          { expanded: false, isPartial: false },
          testTheme(),
          createToolRenderContext({ args, expanded: false, state }),
        ),
      ),
    );
    assert.match(second, /Showing 4 of \d+ diff lines/);
  } finally {
    setCodePreviewSettings(previousSettings);
  }
});

test("registered write result skips pathological whole-file rewrite diffs", () => {
  process.env.CODE_PREVIEW_TOOLS = "write";
  const write = findRenderer(registerRenderers(), "write");
  assert.ok(write.renderResult);
  const before = Array.from({ length: 2_000 }, (_, index) => `before ${index}`).join("\n");
  const after = Array.from({ length: 2_000 }, (_, index) => `after ${index}`).join("\n");

  const rendered = stripAnsi(
    renderComponent(
      write.renderResult(
        {
          content: [{ type: "text", text: "ok" }],
          details: { codePreviewBeforeWrite: { kind: "content", content: before } },
        },
        { expanded: true, isPartial: false },
        testTheme(),
        createToolRenderContext({ args: { path: "rewrite.txt", content: after } }),
      ),
    ),
  );

  assert.match(rendered, /diff skipped for complex rewrite/);
  assert.doesNotMatch(rendered, /Rendering write diff/);
});

test("registered edit renderer hides diff previews until expanded", () => {
  process.env.CODE_PREVIEW_TOOLS = "edit";
  const previousSettings = cloneCodePreviewSettingsForTest();
  setCodePreviewSettings({ ...codePreviewSettings, editDiffPreview: false });
  try {
    const edit = findRenderer(registerRenderers(), "edit");
    assert.ok(edit.renderCall);
    assert.ok(edit.renderResult);

    const args = {
      path: "src/a.ts",
      edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }],
    };
    const collapsedCall = stripAnsi(
      renderComponent(
        edit.renderCall(args, testTheme(), createToolRenderContext({ expanded: false })),
      ),
    );
    assert.match(collapsedCall, /edit src\/a\.ts/);
    assert.match(collapsedCall, /expand/);
    assert.doesNotMatch(collapsedCall, /const value = 2/);

    const expandedCall = stripAnsi(
      renderComponent(edit.renderCall(args, testTheme(), createToolRenderContext())),
    );
    assert.match(expandedCall, /proposed edit/);
    assert.match(expandedCall, /const value = 2/);

    const result = {
      content: [{ type: "text", text: "ok" }],
      details: { diff: "-const value = 1;\n+const value = 2;" },
    };
    const collapsedResult = stripAnsi(
      renderComponent(
        edit.renderResult(
          result,
          { expanded: false, isPartial: false },
          testTheme(),
          createToolRenderContext({ args: { path: "src/a.ts" } }),
        ),
      ),
    );
    assert.match(collapsedResult, /expand/);
    assert.doesNotMatch(collapsedResult, /const value = 2/);

    const expandedResult = stripAnsi(
      renderComponent(
        edit.renderResult(
          result,
          { expanded: true, isPartial: false },
          testTheme(),
          createToolRenderContext({ args: { path: "src/a.ts" } }),
        ),
      ),
    );
    assert.match(expandedResult, /const value = 2/);
  } finally {
    setCodePreviewSettings(previousSettings);
  }
});

test("registered write call reuses cached previews", () => {
  process.env.CODE_PREVIEW_TOOLS = "write";
  const write = findRenderer(registerRenderers(), "write");
  assert.ok(write.renderCall);
  const args = { path: "src/a.ts", content: "const value = 1;\n" };
  const state = {};
  const theme = testTheme();
  const first = write.renderCall(args, theme, createToolRenderContext({ expanded: false, state }));
  const second = write.renderCall(
    args,
    theme,
    createToolRenderContext({ expanded: false, lastComponent: first, state }),
  );

  assert.equal(second, first);
});

test("registered edit result header omits insertion and deletion shape counts", () => {
  process.env.CODE_PREVIEW_TOOLS = "edit";
  const edit = findRenderer(registerRenderers(), "edit");
  assert.ok(edit.renderCall);
  assert.ok(edit.renderResult);

  const state = {};
  const header = edit.renderCall(
    { path: "src/a.ts" },
    testTheme(),
    createToolRenderContext({ executionStarted: true, state }),
  );

  edit.renderResult(
    {
      content: [{ type: "text", text: "ok" }],
      details: { diff: "-old\n+new\n+added\n context\n-removed" },
    },
    { expanded: true, isPartial: false },
    testTheme(),
    createToolRenderContext({ args: { path: "src/a.ts" }, state }),
  );

  const rendered = stripAnsi(renderComponent(header));
  assert.match(rendered, /edit src\/a\.ts · 2 hunks · \+2 -2/);
  assert.doesNotMatch(rendered, /\binsertions?\b/);
  assert.doesNotMatch(rendered, /\bdeletions?\b/);
});

test("registered result renderers stay synchronous without an active session", () => {
  process.env.CODE_PREVIEW_TOOLS = "write,edit";
  const registered = registerRenderers();
  const edit = findRenderer(registered, "edit");
  const write = findRenderer(registered, "write");
  assert.ok(edit.renderResult);
  assert.ok(write.renderResult);

  const before = "a".repeat(21000);
  const after = "b".repeat(21000);
  const editState = {};
  let editInvalidations = 0;
  const editArgs = [
    { content: [{ type: "text", text: "ok" }], details: { diff: `-1 ${before}\n+1 ${after}` } },
    { expanded: true, isPartial: false },
    testTheme(),
    createToolRenderContext({
      args: { path: "src/a.ts" },
      invalidate: () => editInvalidations++,
      state: editState,
    }),
  ] as const;
  const firstEditPreview = edit.renderResult(...editArgs);
  assert.doesNotMatch(stripAnsi(renderComponent(firstEditPreview)), /Rendering edit diff/);
  const settledEditPreview = edit.renderResult(...editArgs);
  assert.equal(settledEditPreview, firstEditPreview);
  assert.equal(editInvalidations, 0);

  const writeState = {};
  let writeInvalidations = 0;
  const writeArgs = [
    {
      content: [{ type: "text", text: "ok" }],
      details: { codePreviewBeforeWrite: { kind: "content", content: before } },
    },
    { expanded: true, isPartial: false },
    testTheme(),
    createToolRenderContext({
      args: { path: "src/a.ts", content: after },
      invalidate: () => writeInvalidations++,
      state: writeState,
    }),
  ] as const;
  const firstWritePreview = write.renderResult(...writeArgs);
  assert.doesNotMatch(stripAnsi(renderComponent(firstWritePreview)), /Rendering write diff/);
  const settledWritePreview = write.renderResult(...writeArgs);
  assert.equal(settledWritePreview, firstWritePreview);
  assert.equal(writeInvalidations, 0);
});
