import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { opaqueFixture, plainTheme } from "pi-cosmic-core/testing";
import { afterEach, test } from "vitest";
import {
  animationSchedulerProbe,
  createToolPresentationHarness,
  issueMessageStyleProblems,
  renderContextFixture,
} from "../../testing";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { createNativeCodemodeRenderers } from "../../src/tools/native-codemode-render";
import { nativeCodemodeSummary } from "../../src/tools/native-codemode-summary";
import { compactStatus } from "../../src/tools/compact-summary";
import { stripAnsi } from "../support/render";

function settings(
  style: "compact" | "preview" = "compact",
  background: "off" | "on" | "border" = "off",
) {
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    syntaxHighlighting: false,
    toolCallTiming: false,
    toolCallCollapsedStyle: style,
    toolCallBackground: background,
  });
}
const noSchedule = () => undefined;
afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));

const output = (
  state = "completed",
  calls: unknown[] = [],
  extra: { fullOutputPath?: string } = {},
): AgentToolResult<unknown> => ({
  content: [
    { type: "text", text: `Script ${state}\nWall time 0.1 seconds\nOutput:\n` },
    { type: "text", text: "FIRST_OUTPUT\nLAST_OUTPUT" },
  ],
  details: { calls, ...extra },
});
interface NativeCallFixture {
  id: string;
  name: string;
  args: unknown;
  status: string;
  error?: string;
  durationMs?: number;
  cost?: number;
}
const call = (status = "ok", extra: Partial<NativeCallFixture> = {}) => ({
  id: "private-call/1",
  name: "read",
  args: '{"path":"/project/a.ts"}',
  status,
  ...extra,
});
function projection(value: AgentToolResult<unknown>, isError = false) {
  return nativeCodemodeSummary("/project")({
    phase: "settled",
    args: { code: "return 1" },
    result: value,
    context: renderContextFixture({ isError, args: { code: "return 1" } }),
  });
}
test("native outcomes require known native evidence, and child delivery is neutral", () => {
  const completed = projection(output("completed", [call()]));
  assert.equal(completed?.outcome, "success");
  assert.equal(completed?.children?.entries[0]?.status, "returned");
  assert.equal(completed?.children?.entries[0]?.returnedCheckmark, true);
  assert.equal(completed?.children?.entries[0]?.metadata, undefined);
  assert.equal(completed?.children?.entries[0]?.durationMs, undefined);
  assert.equal(
    projection(output("completed", [call("error", { error: "handled" })]))?.outcome,
    "warning",
  );
  for (const status of ["running", "cancelled"])
    assert.equal(projection(output("completed", [call(status)]))?.outcome, "uncertain");
  assert.equal(projection(output("completed"), true)?.outcome, "uncertain");
  const aborted = output("failed", [call("cancelled")]);
  aborted.content.push({
    type: "text",
    text: "Script error:\nScript aborted: stopped\n\nTool calls are not undone",
  });
  assert.equal(projection(aborted, true)?.outcome, "error");
  assert.equal(projection(output("failed"), true)?.outcome, "error");
  for (const details of [
    undefined,
    {},
    { calls: [call("made-up")] },
    { calls: [call("ok", { durationMs: -1 })] },
    { calls: [call("ok", { args: {} })] },
    { calls: Array.from({ length: 257 }, () => call()) },
  ])
    assert.equal(projection({ ...output(), details })?.outcome, "uncertain");
  for (const text of [
    "Script completed",
    "user output says Script completed\n",
    "Script completed\nWall time unknown\nOutput:\n",
  ])
    assert.equal(projection({ ...output(), content: [{ type: "text", text }] }), undefined);
});

const truncatedOutput =
  "Warning: truncated output (original token count: 9000)\nTotal output lines: 900\n\n" +
  "TRUNCATED_HEAD\nTRUNCATED_TAIL\n\n" +
  "[Full output: /tmp/RECOVERABLE_OUTPUT (read with offset/limit)]";

test("recoverable native output does not raise attention; missing recovery remains a warning", () => {
  for (const path of ["/tmp/RECOVERABLE_OUTPUT", undefined, "", " \n\t ", 3, "x".repeat(4097)]) {
    const value = output("completed", [call()]);
    value.content[1] = { type: "text", text: truncatedOutput };
    value.details = { calls: [call()], fullOutputPath: path };
    const before = structuredClone(value);
    const summary = projection(value)!;
    const saved = path === "/tmp/RECOVERABLE_OUTPUT";
    const clipping = summary.issues?.find((entry) => entry.code === "native-output-truncated");
    assert.equal(clipping?.severity, saved ? "info" : "warning");
    assert.equal(compactStatus("settled", summary), saved ? "success" : "warning");
    assert.equal(clipping?.detail, saved ? path : undefined);
    assert.deepEqual(value, before);
  }
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
  const unsaved = output();
  unsaved.content[1] = {
    type: "text",
    text: truncatedOutput + "\n\n[Could not save the full output: ENOSPC: disk full]",
  };
  const summary = projection(unsaved)!;
  assert.equal(compactStatus("settled", summary), "warning");
  assert.equal(
    summary.issues?.find((entry) => entry.code === "native-output-save-failed")?.severity,
    "warning",
  );
});

for (const style of ["compact", "preview"] as const)
  test(`native ${style} keeps recoverable clipping expanded-only without changing output`, () => {
    settings(style);
    const tool = createNativeCodemodeRenderers("/project", noSchedule);
    const value = output("completed", [call()], { fullOutputPath: "/tmp/RECOVERABLE_OUTPUT" });
    value.content[1] = { type: "text", text: truncatedOutput };
    const before = structuredClone(value);
    const clipping = projection(value)!.issues!.find(
      (entry) => entry.code === "native-output-truncated",
    )!;
    const harness = createToolPresentationHarness(tool);
    for (const frame of harness.cycle({ code: "return 'SOURCE_MARKER';" }, value)) {
      const text = stripAnsi(frame.text);
      assert.equal(text.includes(clipping.message), frame.expanded);
      if (frame.expanded)
        for (const marker of [
          "SOURCE_MARKER",
          "TRUNCATED_HEAD",
          "TRUNCATED_TAIL",
          clipping.detail!,
        ])
          assert.ok(text.includes(marker), marker);
    }
    assert.deepEqual(value, before);
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
  assert.equal(JSON.stringify(summary).includes(secret), false);
  for (const issue of [
    ...(summary.issues ?? []),
    ...(summary.children?.entries.flatMap((entry) => entry.issues ?? []) ?? []),
  ])
    assert.deepEqual(issueMessageStyleProblems(issue.message), []);
  assert.deepEqual(value, before);
  assert.equal(
    projection(output("completed", [call("ok", { args: '{"path":"cut...' })]))?.children?.entries[0]
      ?.subject,
    "",
  );
});

test("native error attention omits duplicate details but preserves distinct diagnostics", () => {
  for (const extra of ["", "\nAdditional diagnostic context"]) {
    const diagnostic = `Nested failure${extra}`;
    const value = output("completed", [call("error", { error: diagnostic })]);
    const before = structuredClone(value);
    const error = projection(value)?.children?.entries[0]?.issues?.find(
      (entry) => entry.severity === "error",
    );
    assert.ok(error);
    assert.equal(error.detail, extra ? diagnostic : undefined);
    assert.deepEqual(value, before);
  }
});

for (const style of ["compact", "preview"] as const)
  for (const mode of ["off", "on", "border"] as const)
    test(`native ${style}/${mode} expansion preserves source, errors, images, spill paths and malformed history`, () => {
      settings(style, mode);
      const tool = createNativeCodemodeRenderers("/project", noSchedule);
      const source = Array.from({ length: 20 }, (_, index) => `text('SOURCE_${index}');`).join(
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
              assert.ok(text.includes(marker), marker);
        }
        for (const width of [16, 40]) assert.ok(harness.render(width).length);
      }
      assert.deepEqual(value, before);
    });

test("expanded native source/output survive hostile theme construction and drawing", () => {
  settings();
  const badTheme = opaqueFixture({
    ...plainTheme,
    fg(token: string, text: string) {
      if (token === "toolOutput") throw new Error("content theme unavailable");
      return text;
    },
  });
  const tool = createNativeCodemodeRenderers("/project", noSchedule);
  const h = createToolPresentationHarness(tool, { theme: badTheme });
  h.call({ code: "// SOURCE_COMPLETE\nreturn 1;" }, { expanded: true });
  h.result(output(), { expanded: true });
  const text = stripAnsi(h.render(100).join("\n"));
  assert.ok(text.includes("SOURCE_COMPLETE"));
  assert.ok(text.includes("LAST_OUTPUT"));
});

test("native renderers use the injected animation owner and stop at settlement", () => {
  settings();
  const probe = animationSchedulerProbe();
  const h = createToolPresentationHarness(
    createNativeCodemodeRenderers("/project", probe.schedule),
  );
  h.call({ code: "return 1" }, { executionStarted: true });
  h.result({ content: [], details: { calls: [call("running")] } }, { isPartial: true });
  h.render();
  assert.ok(probe.scheduled > 0);
  h.result(output());
  h.render();
  assert.ok(probe.stops > 0);
});
