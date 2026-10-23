import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { failingTheme } from "pi-cosmic-core/testing";
import { beforeEach, test } from "vitest";
import {
  applyPresentationSettings,
  createToolPresentationHarness,
  issueMessageStyleProblems,
} from "../../testing";
import type { NativeCodemodeCall } from "../../src/tools/native-codemode-evidence";
import {
  codemodeRenderers,
  nativeCall,
  scriptResult,
  settledSummary,
} from "../support/native-codemode";
import { stripAnsi } from "../support/render";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";

const settings = (style: "compact" | "preview", background: "off" | "on" | "border" = "off") =>
  applyPresentationSettings({ toolCallCollapsedStyle: style, toolCallBackground: background });
beforeEach(() =>
  applyPresentationSettings({
    syntaxHighlighting: false,
    toolCallTiming: false,
    toolCallCollapsedStyle: "compact",
    toolCallBackground: "off",
  }),
);

const output = (
  state = "completed",
  calls: unknown[] = [],
  extra: { fullOutputPath?: string } = {},
): AgentToolResult<unknown> =>
  scriptResult(state, { calls, ...extra }, { type: "text", text: "FIRST_OUTPUT\nLAST_OUTPUT" });
const call = (
  status: NativeCodemodeCall["status"] = "ok",
  extra: Partial<NativeCodemodeCall> = {},
) => nativeCall({ id: "private-call/1", status, ...extra });
const projection = (value: AgentToolResult<unknown>, isError = false) =>
  settledSummary(value, { code: "return 1", isError });
test("native outcomes require known native evidence, and child delivery is neutral", () => {
  const completed = projection(output("completed", [call()]));
  assert.equal(completed?.outcome, "success");
  assert.equal(completed?.children?.entries[0]?.status, "returned");
  assert.equal(completed?.children?.entries[0]?.metadata, undefined);
  assert.equal(completed?.children?.entries[0]?.durationMs, undefined);
  assert.equal(
    projection(output("completed", [call("error", { error: "handled" })]))?.outcome,
    "warning",
  );
  const aborted = output("failed", [call("cancelled")]);
  aborted.content.push({
    type: "text",
    text: "Script error:\nScript aborted: stopped\n\nTool calls are not undone",
  });
  assert.equal(projection(aborted, true)?.outcome, "error");
  for (const text of [
    "Script completed",
    "user output says Script completed\n",
    "Script completed\nWall time unknown\nOutput:\n",
  ])
    assert.equal(projection({ ...output(), content: [{ type: "text", text }] }), undefined);
});

test("saved output cannot hide script failures, child failures, or incomplete call evidence", () => {
  const recovery = { fullOutputPath: "/tmp/RECOVERABLE_OUTPUT" };
  assert.equal(projection(output("failed", [], recovery), true)?.outcome, "error");
  assert.equal(projection(output("completed", [call("error")], recovery))?.outcome, "warning");
  assert.equal(
    projection({ ...output("completed", [], recovery), details: { ...recovery, calls: [null] } })
      ?.outcome,
    "uncertain",
  );
});

for (const style of ["compact", "preview"] as const)
  test(`native ${style} source rendering does not invoke argument accessors`, () => {
    settings(style);
    let invoked = false;
    const args = Object.defineProperty({}, "code", {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("Argument accessors must remain inert");
      },
    });
    const harness = createToolPresentationHarness(codemodeRenderers());
    for (const expanded of [false, true]) {
      harness.call(args, { expanded });
      assert.doesNotThrow(() => harness.render(100));
    }
    assert.equal(invoked, false);
  });

test("projection sanitizes bounded attention/targets without changing raw native details", () => {
  const secret = "sk-verysecretvalue123456";
  const value = output("completed", [
    call("error", {
      name: "bash",
      args: JSON.stringify({ command: `curl -H 'Authorization: Bearer ${secret}'` }),
      error: `Error: token=${secret}\nUse tool() to retry private-call/1`,
    }),
  ]);
  const before = structuredClone(value);
  const summary = projection(value)!;
  assert.equal(Fn.pipe(JSON.stringify(summary), Str.includes(secret)), false);
  for (const issue of [
    ...(summary.issues ?? []),
    ...Arr.flatMap(summary.children?.entries ?? [], (entry) => entry.issues ?? []),
  ])
    assert.deepEqual(issueMessageStyleProblems(issue.message), []);
  assert.deepEqual(value, before);
  assert.equal(
    projection(output("completed", [call("ok", { args: '{"path":"cut...' })]))?.children?.entries[0]
      ?.subject,
    "",
  );
});

for (const style of ["compact", "preview"] as const)
  for (const mode of ["off", "on", "border"] as const)
    test(`native ${style}/${mode} expansion preserves source, errors, images, spill paths and malformed history`, () => {
      settings(style, mode);
      const tool = codemodeRenderers();
      const source = Arr.join(
        Array.from({ length: 20 }, (_, index) => `text('SOURCE_${index}');`),
        "\n",
      );
      const value = output("failed", [call("error", { error: "Nested failure" })], {
        fullOutputPath: "/tmp/native-full.txt",
      });
      value.content.push(
        {
          type: "text",
          text: "Script error:\nError: SCRIPT_FAILURE\nRead /tmp/native-full.txt; prior effects are not undone",
        },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      );
      const before = structuredClone(value);
      for (const malformed of [false, true]) {
        const result = malformed ? { ...value, details: { calls: [{ broken: true }] } } : value;
        const harness = createToolPresentationHarness(tool);
        harness.call({ code: source });
        harness.result({ content: [], details: { calls: [call("running")] } }, { isPartial: true });
        harness.render(80);
        for (const frame of harness.cycle({ code: source }, result, {
          invalidate: "after",
          overrides: () => ({ isError: true, showImages: false }),
        })) {
          const text = stripAnsi(frame.text);
          if (frame.expanded)
            for (const marker of [
              "SOURCE_0",
              "SOURCE_19",
              "FIRST_OUTPUT",
              "LAST_OUTPUT",
              "SCRIPT_FAILURE",
              "/tmp/native-full.txt",
              "image/png",
            ])
              assert.ok(Fn.pipe(text, Str.includes(marker)), marker);
        }
        for (const width of [16, 40]) assert.ok(harness.render(width).length);
      }
      assert.deepEqual(value, before);
    });

test("expanded native source/output survive hostile theme construction and drawing", () => {
  const badTheme = failingTheme({
    message: "content theme unavailable",
    when: (token) => token === "toolOutput",
  });
  const tool = codemodeRenderers();
  const h = createToolPresentationHarness(tool, { theme: badTheme });
  h.call({ code: "// SOURCE_COMPLETE\nreturn 1;" }, { expanded: true });
  h.result(output(), { expanded: true });
  const text = stripAnsi(Arr.join(h.render(100), "\n"));
  assert.ok(Fn.pipe(text, Str.includes("SOURCE_COMPLETE")));
  assert.ok(Fn.pipe(text, Str.includes("LAST_OUTPUT")));
});
