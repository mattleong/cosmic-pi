import assert from "node:assert/strict";
import type { AgentToolResult, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { opaqueFixture, plainTheme } from "pi-cosmic-core/testing";
import { afterEach, test } from "vitest";
import { createToolPresentationHarness } from "../../testing";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { styleNativeMcp } from "../../src/tools/native-mcp-render";
import type { NativeMcpEvidence } from "../../src/tools/native-mcp-summary";
import { stripAnsi } from "../support/render";

const header =
  "Warning: truncated output (original token count: 9000)\nTotal output lines: 900\n\n";
const path = "/tmp/RECOVERY_PATH_RETAINED";
const details = { server: "docs", tool: "lookup", fullOutputPath: path };
const output = `${header}HEAD_RETAINED\nTAIL_RETAINED\n\n[Full output: ${path} (read it with offset/limit)]`;
const value = (text = output, metadata: NativeMcpEvidence = details): AgentToolResult<unknown> => ({
  content: [{ type: "text", text }],
  details: metadata,
});
const definition = (): ToolDefinition<any, any, any> => ({
  name: "mcp__docs__lookup",
  label: "docs/lookup",
  namespace: { name: "mcp__docs" },
  description: "Owned MCP fixture",
  parameters: opaqueFixture({ type: "object" }),
  execute: () => Promise.resolve(value()),
});
const settings = (style: "compact" | "preview", background: "off" | "on" | "border" = "off") =>
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    syntaxHighlighting: false,
    toolCallTiming: false,
    toolCallCollapsedStyle: style,
    toolCallBackground: background,
  });

afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));

for (const style of ["compact", "preview"] as const)
  for (const background of ["off", "on", "border"] as const)
    test(`recoverable MCP clipping stays quiet through ${style}/${background} expansion and fallback`, () => {
      settings(style, background);
      const outputFailureTheme: Theme = opaqueFixture({
        ...plainTheme,
        fg(color: Parameters<Theme["fg"]>[0], text: string) {
          if (color === "toolOutput") throw new Error("Output style unavailable");
          return plainTheme.fg(color, text);
        },
      });
      const themes = [plainTheme, outputFailureTheme];
      // A producer's total theme fallback is exercised without theme-dependent shell chrome.
      if (style === "preview" && background !== "border")
        themes.push(
          opaqueFixture({
            ...plainTheme,
            fg() {
              throw new Error("Theme unavailable");
            },
          }),
        );
      for (const theme of themes) {
        const original = definition();
        const tool = styleNativeMcp(original);
        assert.equal(tool.execute, original.execute);
        assert.equal(tool.parameters, original.parameters);
        const h = createToolPresentationHarness(tool, { theme });
        const result: AgentToolResult<unknown> = {
          ...value(),
          content: [...value().content, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
        };
        const before = structuredClone(result);
        for (const expanded of [false, true, false, true]) {
          h.call({ query: "ARGUMENT_RETAINED" }, { expanded, isPartial: false, showImages: false });
          h.result(result, { expanded, showImages: false });
          h.invalidate();
          for (const width of expanded ? [160] : [16, 60, 160]) {
            const rows = h.render(width);
            assert.ok(rows.every((row) => visibleWidth(row) <= width));
            const text = stripAnsi(rows.join("\n"));
            if (expanded)
              for (const marker of [
                "ARGUMENT_RETAINED",
                "Warning: truncated output",
                "Total output lines:",
                "HEAD_RETAINED",
                "TAIL_RETAINED",
                path,
                "image/png",
              ])
                assert.ok(text.includes(marker), marker);
            else {
              assert.equal(text.includes("Warning: truncated output"), false);
              assert.equal(text.includes("Total output lines:"), false);
              assert.equal(text.includes(path), false);
            }
          }
        }
        assert.deepEqual(result, before);
      }
    });

test("only a recognized owned recoverable MCP envelope is quietly suppressed", () => {
  settings("preview");
  let getterInvoked = false;
  const accessor = Object.defineProperty({ server: "docs", tool: "lookup" }, "fullOutputPath", {
    get() {
      getterInvoked = true;
      return path;
    },
  });
  const inherited = Object.assign(Object.create({ fullOutputPath: path }), {
    server: "docs",
    tool: "lookup",
  });
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

test("quiet saved resource clipping still exposes aggregate-listing uncertainty", () => {
  for (const style of ["compact", "preview"] as const) {
    settings(style);
    const resource: ToolDefinition<any, any, any> = {
      ...definition(),
      name: "list_mcp_resources",
      label: "list_mcp_resources",
    };
    const h = createToolPresentationHarness(styleNativeMcp(resource));
    h.call({});
    h.result(value(output, { server: "", tool: resource.name, fullOutputPath: path }));
    const text = stripAnsi(h.render(160).join("\n"));
    assert.ok(text.includes("Listing failures couldn't be checked"));
    assert.equal(text.includes("Warning: truncated output"), false);
  }
});
