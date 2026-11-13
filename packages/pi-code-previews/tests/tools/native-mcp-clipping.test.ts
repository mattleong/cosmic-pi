import assert from "node:assert/strict";
import type { AgentToolResult, ToolInfo } from "@earendil-works/pi-coding-agent";
import { beforeEach, test } from "vitest";
import { applyPresentationSettings, createToolPresentationHarness } from "pi-code-previews/testing";
import type { NativeMcpEvidence } from "../../src/tools/native-mcp-summary";
import { NATIVE_TRUNCATION_HEADER, styleNativeMcp } from "../support/native-mcp";
import { stripAnsi } from "pi-cosmic-core";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";

const header = NATIVE_TRUNCATION_HEADER;
const path = "/tmp/RECOVERY_PATH_RETAINED";
const details = { server: "docs", tool: "lookup", fullOutputPath: path };
const output = `${header}HEAD_RETAINED\nTAIL_RETAINED\n\n[Full output: ${path} (read it with offset/limit)]`;
const value = (text = output, metadata: NativeMcpEvidence = details): AgentToolResult<unknown> => ({
  content: [{ type: "text", text }],
  details: metadata,
});
const definition = (): Pick<ToolInfo, "name" | "namespace"> => ({
  name: "mcp__docs__lookup",
  namespace: { name: "mcp__docs" },
});
beforeEach(() => applyPresentationSettings({ syntaxHighlighting: false, toolCallTiming: false }));

test("only a recognized owned recoverable MCP envelope is quietly suppressed", () => {
  applyPresentationSettings({ toolCallCollapsedStyle: "preview", toolCallBackground: "off" });
  let getterInvoked = false;
  const accessor = Object.defineProperty({ server: "docs", tool: "lookup" }, "fullOutputPath", {
    get() {
      getterInvoked = true;
      return path;
    },
  });
  const inherited = { server: "docs", tool: "lookup" };
  Reflect.setPrototypeOf(inherited, { fullOutputPath: path });
  // A failure collapses to its issue, and a saved, owned envelope to its tag: both are hidden.
  // Where an owned envelope's issue states the truncation, the preview keeps only its output:
  // explained. Everything else keeps the original text.
  type Expected = "hidden" | "explained" | "original";
  const cases: Array<{
    result: AgentToolResult<unknown>;
    expected: Expected;
    isError?: boolean;
    isPartial?: boolean;
  }> = [
    { result: value(), expected: "hidden" },
    ...Arr.map(
      [
        [undefined, "original"],
        [null, "original"],
        [{}, "original"],
        [{ ...details, fullOutputPath: undefined }, "explained"],
        [{ ...details, fullOutputPath: "" }, "explained"],
        [{ ...details, fullOutputPath: " \n\t " }, "explained"],
        [{ ...details, fullOutputPath: 42 }, "original"],
        [{ ...details, fullOutputPath: Fn.pipe("x", Str.repeat(4097)) }, "original"],
        [{ ...details, server: "other" }, "original"],
        [{ ...details, tool: "other" }, "original"],
        [inherited, "explained"],
        [accessor, "original"],
      ] as const,
      ([metadata, expected]) => ({ result: { ...value(), details: metadata }, expected }),
    ),
    {
      result: value(
        `${header}LOST_OUTPUT\n\n[Could not save the full output: SAVE_FAILURE_RETAINED]`,
        {
          server: "docs",
          tool: "lookup",
        },
      ),
      expected: "explained",
    },
    {
      result: value(`${header}LOST_OUTPUT\n\n[Could not save the full output: STALE_PATH_FAILURE]`),
      expected: "explained",
    },
    { result: value(), expected: "hidden", isError: true },
    { result: value(), expected: "original", isPartial: true },
    {
      result: {
        ...value(),
        content: [...value().content, { type: "text", text: "EXTRA_WARNING" }],
      },
      expected: "original",
    },
  ];
  Arr.forEach(cases, (item, index) => {
    const h = createToolPresentationHarness(styleNativeMcp(definition()));
    h.call({}, { executionStarted: true, isPartial: item.isPartial ?? false });
    h.result(item.result, { isError: item.isError ?? false, isPartial: item.isPartial ?? false });
    const collapsed = stripAnsi(Arr.join(h.render(160), "\n"));
    const has = (text: string) => Fn.pipe(collapsed, Str.includes(text));
    const shown = {
      envelope: has("Warning: truncated output"),
      output: has("LOST_OUTPUT") || has("TAIL_RETAINED"),
    };
    const expected = {
      hidden: { envelope: false, output: false },
      explained: { envelope: false, output: true },
      original: { envelope: true, output: shown.output },
    }[item.expected];
    assert.deepEqual(shown, expected, `case ${index} is ${item.expected}`);
    h.call({}, { expanded: true });
    h.result(item.result, {
      expanded: true,
      isError: item.isError ?? false,
      isPartial: item.isPartial ?? false,
    });
    const expanded = stripAnsi(Arr.join(h.render(400), "\n"));
    for (const part of item.result.content)
      if (part.type === "text")
        for (const line of Arr.filter(
          Str.split(part.text, "\n"),
          (entry) => Str.trim(entry) !== "",
        ))
          assert.ok(
            Fn.pipe(expanded, Str.includes(Str.trim(line))),
            "Original text survives expansion",
          );
  });
  assert.equal(getterInvoked, false);

  for (const text of [
    "Warning: PROVIDER_WARNING_RETAINED",
    "Warning: truncated output (unknown format)\nUNKNOWN_FORMAT_RETAINED",
    "Warning: ordinary warning\nTotal output lines: 900\n\nNOT_A_NATIVE_ENVELOPE",
  ]) {
    const h = createToolPresentationHarness(styleNativeMcp(definition()));
    h.call({});
    h.result(value(text));
    assert.ok(Fn.pipe(stripAnsi(Arr.join(h.render(160), "\n")), Str.includes(text)));
  }
});
