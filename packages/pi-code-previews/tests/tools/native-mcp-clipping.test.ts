import assert from "node:assert/strict";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { beforeEach, test } from "vitest";
import {
  animationSchedulerProbe,
  applyPresentationSettings,
  createToolPresentationHarness,
} from "pi-code-previews/testing";
import { createNativeMcpRenderers } from "../../src/tools/native-mcp-render";
import type { NativeMcpEvidence } from "../../src/tools/native-mcp-summary";
import { stripAnsi } from "pi-cosmic-core";

const styleNativeMcp = (definition: ToolDefinition) =>
  createNativeMcpRenderers(definition.name, definition, undefined, {
    scheduleAnimation: animationSchedulerProbe().schedule,
  });

const header =
  "Warning: truncated output (original token count: 9000)\nTotal output lines: 900\n\n";
const path = "/tmp/RECOVERY_PATH_RETAINED";
const details = { server: "docs", tool: "lookup", fullOutputPath: path };
const output = `${header}HEAD_RETAINED\nTAIL_RETAINED\n\n[Full output: ${path} (read it with offset/limit)]`;
const value = (text = output, metadata: NativeMcpEvidence = details): AgentToolResult<unknown> => ({
  content: [{ type: "text", text }],
  details: metadata,
});
const definition = (): ToolDefinition => ({
  name: "mcp__docs__lookup",
  label: "docs/lookup",
  namespace: { name: "mcp__docs" },
  description: "Owned MCP fixture",
  parameters: { type: "object" },
  execute: () => Promise.resolve(value()),
});
const settings = (style: "compact" | "preview", background: "off" | "on" | "border" = "off") =>
  applyPresentationSettings({ toolCallCollapsedStyle: style, toolCallBackground: background });
beforeEach(() => applyPresentationSettings({ syntaxHighlighting: false, toolCallTiming: false }));

test("only a recognized owned recoverable MCP envelope is quietly suppressed", () => {
  settings("preview");
  let getterInvoked = false;
  const accessor = Object.defineProperty({ server: "docs", tool: "lookup" }, "fullOutputPath", {
    get() {
      getterInvoked = true;
      return path;
    },
  });
  const inherited = { server: "docs", tool: "lookup" };
  Reflect.setPrototypeOf(inherited, { fullOutputPath: path });
  const cases: Array<{ result: AgentToolResult<unknown>; isError?: boolean; isPartial?: boolean }> =
    [
      ...[
        undefined,
        null,
        {},
        { ...details, fullOutputPath: undefined },
        { ...details, fullOutputPath: "" },
        { ...details, fullOutputPath: " \n\t " },
        { ...details, fullOutputPath: 42 },
        { ...details, fullOutputPath: "x".repeat(4097) },
        { ...details, server: "other" },
        { ...details, tool: "other" },
        inherited,
        accessor,
      ].map((metadata) => ({ result: { ...value(), details: metadata } })),
      {
        result: value(
          `${header}LOST_OUTPUT\n\n[Could not save the full output: SAVE_FAILURE_RETAINED]`,
          {
            server: "docs",
            tool: "lookup",
          },
        ),
      },
      {
        result: value(
          `${header}LOST_OUTPUT\n\n[Could not save the full output: STALE_PATH_FAILURE]`,
        ),
      },
      { result: value(), isError: true },
      { result: value(), isPartial: true },
      {
        result: {
          ...value(),
          content: [...value().content, { type: "text", text: "EXTRA_WARNING" }],
        },
      },
    ];
  for (const item of cases) {
    const h = createToolPresentationHarness(styleNativeMcp(definition()));
    h.call({}, { executionStarted: true, isPartial: item.isPartial ?? false });
    h.result(item.result, { isError: item.isError ?? false, isPartial: item.isPartial ?? false });
    assert.ok(stripAnsi(h.render(160).join("\n")).includes("Warning: truncated output"));
    h.call({}, { expanded: true });
    h.result(item.result, {
      expanded: true,
      isError: item.isError ?? false,
      isPartial: item.isPartial ?? false,
    });
    const expanded = stripAnsi(h.render(400).join("\n"));
    for (const part of item.result.content)
      if (part.type === "text")
        for (const line of part.text.split("\n").filter((entry) => entry.trim()))
          assert.ok(expanded.includes(line.trim()), "Original text survives expansion");
  }
  assert.equal(getterInvoked, false);

  for (const text of [
    "Warning: PROVIDER_WARNING_RETAINED",
    "Warning: truncated output (unknown format)\nUNKNOWN_FORMAT_RETAINED",
    "Warning: ordinary warning\nTotal output lines: 900\n\nNOT_A_NATIVE_ENVELOPE",
  ]) {
    const h = createToolPresentationHarness(styleNativeMcp(definition()));
    h.call({});
    h.result(value(text));
    assert.ok(stripAnsi(h.render(160).join("\n")).includes(text));
  }
});
