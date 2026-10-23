import assert from "node:assert/strict";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { createHighlighter, createJavaScriptRegexEngine } from "shiki";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { applyPresentationSettings, createToolPresentationHarness } from "../../testing";
import {
  clearCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
} from "../../src/application/capability";
import { acquireProjectionOwnership } from "../../src/shared/projection-ownership";
import { clearSyntaxProjection, publishSyntaxProjection } from "../../src/syntax/projection";
import { getShikiStatus } from "../../src/syntax/render";
import { codemodeRenderers, scriptResult } from "../support/native-codemode";
import { builtinRenderers, textResult } from "../support/render";

const owner = acquireProjectionOwnership("streaming-highlight-test");
const highlighter = await createHighlighter({
  themes: ["dark-plus"],
  langs: ["javascript", "typescript"],
  engine: createJavaScriptRegexEngine(),
});

beforeAll(() => {
  publishSyntaxProjection(owner, {
    theme: "dark-plus",
    highlighter,
    loadedLanguages: ["javascript", "typescript"],
    failedThemes: [],
    failedLanguages: [],
    status: { initialized: true, loadedLanguages: 2, pendingLanguages: 0, statusVersion: 1 },
  });
  // Builtin previews highlight only for the session that owns them.
  installCodePreviewSessionCapability({
    run: () => Promise.reject(new Error("not used")),
    defer: () => () => undefined,
    schedule: () => () => undefined,
  });
});
afterAll(() => {
  clearCodePreviewSessionCapability();
  clearSyntaxProjection(owner);
  highlighter.dispose();
});
beforeEach(() =>
  applyPresentationSettings({
    syntaxHighlighting: true,
    shikiTheme: "dark-plus",
    toolCallTiming: false,
    toolCallCollapsedStyle: "preview",
    toolCallBackground: "off",
  }),
);

// The harness theme is unstyled, so any escape sequence comes from syntax highlighting.
const highlighted = (rows: readonly string[]) =>
  Fn.pipe(Arr.join(rows, "\n"), Str.includes("\x1b["));

const program = Arr.join(
  [
    "const first = 1;",
    "\tconst tabbed = `template`;",
    "const crlf = 'windows';\r",
    "if (first) {",
    "  text(String(first));",
    "  /* a comment that starts inside the collapsed rows",
    "     and continues past them */ const after = 2;",
    `  const long = "${Fn.pipe("wrapped ", Str.repeat(12))}";\r`,
    "}",
    "return first;",
  ],
  "\n",
);

test("a collapsed codemode program shows exactly the first rows of the expanded program", () => {
  const harness = createToolPresentationHarness(codemodeRenderers());
  for (const width of [40, 60, 120]) {
    harness.call({ code: program }, { expanded: true });
    const expanded = harness.render(width);
    harness.call({ code: program }, { expanded: false });
    const collapsed = harness.render(width);
    assert.ok(highlighted(collapsed));
    assert.equal(collapsed.length, 1 + 8 + 1);
    assert.deepEqual(collapsed.slice(0, 9), expanded.slice(0, 9));
    assert.ok(expanded.length > 9);
  }
});

// Pi draws a live row first with the arguments parsed so far, then once per delta with a new object.
// Compact rows build their expanded body lazily, so each step also draws a frame.
const deltas = (end: number) =>
  Arr.map(Arr.range(1, Math.ceil(end / 20)), (step) =>
    Fn.pipe(program, Str.slice(0, Math.min(step * 20, end))),
  );

test("streaming codemode arguments render plain until the program is complete", () => {
  const harness = createToolPresentationHarness(codemodeRenderers());
  harness.call({}, { argsComplete: false });
  harness.render(80);
  const cached = getShikiStatus().cacheSize;
  for (const expanded of [false, true])
    for (const code of deltas(program.length)) {
      harness.call({ code }, { expanded, argsComplete: false });
      assert.equal(highlighted(harness.render(80)), false);
    }
  assert.equal(getShikiStatus().cacheSize, cached);
  harness.call({ code: program }, { expanded: false, argsComplete: true });
  assert.ok(highlighted(harness.render(80)));
});

test("a replayed codemode row highlights its program even though Pi never marks its arguments complete", () => {
  const harness = createToolPresentationHarness(codemodeRenderers());
  harness.call({ code: program }, { argsComplete: false });
  harness.result(scriptResult("completed", { calls: [] }, { type: "text", text: "done" }));
  assert.ok(highlighted(harness.render(80)));
});

test("a replayed codemode row without a saved result draws like a settled row", () => {
  for (const expanded of [false, true]) {
    const settled = createToolPresentationHarness(codemodeRenderers());
    settled.call({ code: program }, { expanded });
    const replay = createToolPresentationHarness(codemodeRenderers());
    const args = { code: program };
    replay.call(args, { expanded, argsComplete: false, executionStarted: false, isPartial: true });
    assert.ok(highlighted(replay.render(80)));
    assert.deepEqual(replay.render(80), settled.render(80));
    // Redrawing the same arguments, as Pi does when it applies the expansion setting, is not a delta.
    replay.invalidate();
    assert.deepEqual(replay.render(80), settled.render(80));
  }
});

const writeRenderers = () => {
  const renderers = builtinRenderers("write");
  assert.ok(renderers);
  return renderers;
};

for (const style of ["preview", "compact"] as const)
  test(`streaming ${style} write content renders plain until its arguments are complete`, () => {
    applyPresentationSettings({ toolCallCollapsedStyle: style });
    const renderers = writeRenderers();
    for (const expanded of style === "compact" ? [true] : [false, true]) {
      const harness = createToolPresentationHarness(renderers);
      harness.call({}, { expanded, argsComplete: false });
      harness.render(80);
      for (const content of deltas(program.length - 1)) {
        harness.call({ path: "/project/a.ts", content }, { expanded, argsComplete: false });
        assert.equal(highlighted(harness.render(80)), false);
      }
      const args = { path: "/project/a.ts", content: program };
      harness.call(args, { expanded, argsComplete: false });
      assert.equal(highlighted(harness.render(80)), false);
      harness.call(args, { expanded, argsComplete: true });
      assert.ok(highlighted(harness.render(80)));
    }
    const replay = createToolPresentationHarness(renderers);
    replay.call(
      { path: "/project/a.ts", content: program },
      { expanded: true, argsComplete: false },
    );
    replay.result(textResult("Successfully wrote to a.ts"), { expanded: true });
    assert.ok(highlighted(replay.render(80)));
  });

for (const style of ["preview", "compact"] as const)
  test(`a replayed ${style} write without a saved result draws like a settled row`, () => {
    applyPresentationSettings({ toolCallCollapsedStyle: style });
    const renderers = writeRenderers();
    for (const expanded of style === "compact" ? [true] : [false, true]) {
      const settled = createToolPresentationHarness(renderers);
      settled.call({ path: "/project/a.ts", content: program }, { expanded });
      const replay = createToolPresentationHarness(renderers);
      replay.call(
        { path: "/project/a.ts", content: program },
        { expanded, argsComplete: false, executionStarted: false, isPartial: true },
      );
      assert.ok(highlighted(replay.render(80)));
      assert.deepEqual(replay.render(80), settled.render(80));
    }
  });
