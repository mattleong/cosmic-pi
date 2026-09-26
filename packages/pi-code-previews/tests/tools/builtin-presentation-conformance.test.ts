import { afterEach, describe, expect, test } from "vitest";
import type { ToolDefinition, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { extensionApiFixture } from "pi-cosmic-core/testing";
import { createToolPresentationHarness } from "../../testing";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { registerToolRenderers } from "../../src/tools/renderers/registration";
import { ALL_CODE_PREVIEW_TOOLS } from "../../src/tools/names";
import { previewBodiesDisabled, stripAnsi } from "../support/render";

const cases = [
  {
    name: "bash",
    args: { command: "printf 'FIRST_COMMAND\\n'\nprintf 'LAST_COMMAND\\n'" },
    output: "first log\nlast log",
    retained: "last log",
  },
  {
    name: "read",
    args: { path: "/project/source.ts" },
    output: "const first = 1;\nconst last = 2;",
    retained: "const last",
  },
  {
    name: "write",
    args: { path: "/project/source.ts", content: "const first = 1;\nconst last = 2;" },
    output: "Successfully wrote 38 bytes to /project/source.ts",
    retained: "const last",
  },
  {
    name: "edit",
    args: {
      path: "/project/source.ts",
      edits: Array.from({ length: 5 }, (_, index) => ({
        oldText: `OLD_${index}`,
        newText: `NEW_${index}`,
      })),
    },
    output: "Successfully replaced text in /project/source.ts.",
    retained: "NEW_4",
  },
  {
    name: "grep",
    args: { pattern: "needle", path: "/project", context: 2 },
    output: "source.ts:1:needle\nsource.ts:2:tail",
    retained: "tail",
  },
  {
    name: "find",
    args: { pattern: "*.ts", path: "/project" },
    output: "src/first.ts\nsrc/last.ts",
    retained: "last.ts",
  },
  { name: "ls", args: { path: "/project" }, output: "first.ts\nlast.ts", retained: "last.ts" },
] as const;

function registered(
  mode: "off" | "on" | "border" = "off",
  style: "compact" | "preview" = "compact",
) {
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    tools: [...ALL_CODE_PREVIEW_TOOLS],
    toolCallBackground: mode,
    toolCallCollapsedStyle: style,
    toolCallTiming: false,
    ...previewBodiesDisabled,
  });
  const tools = new Map<string, ToolDefinition>();
  const api = extensionApiFixture({
    getAllTools: () => [],
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
  });
  registerToolRenderers(api, "/project", { toolOptions: {} });
  return tools;
}
function result(...texts: string[]): AgentToolResult<unknown> {
  return { content: texts.map((text) => ({ type: "text" as const, text })), details: {} };
}
function plain(lines: string[]) {
  return stripAnsi(lines.join("\n"));
}
afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));

describe("registered builtin presentation", () => {
  for (const fixture of cases) {
    test(`${fixture.name} retains expanded content across toggles and narrow widths`, () => {
      for (const mode of ["off", "on", "border"] as const) {
        const tool = registered(mode).get(fixture.name)!;
        const harness = createToolPresentationHarness(tool);
        harness.call(fixture.args);
        harness.result(result(fixture.output), { isPartial: true });
        expect(plain(harness.render(100)).includes(fixture.retained)).toBe(false);
        harness.result(result(fixture.output));
        for (const expanded of [true, false, true]) {
          harness.call(fixture.args, { expanded });
          harness.result(result(fixture.output), { expanded });
          const text = plain(harness.render(100));
          expect(text.includes(fixture.retained)).toBe(expanded);
          for (const width of [16, 40])
            expect(harness.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
          harness.invalidate();
        }
      }
    });
    test(`${fixture.name} retains raw unknown errors once and keeps failure call source`, () => {
      const sourceMarkers =
        fixture.name === "bash"
          ? ["LAST_COMMAND"]
          : fixture.name === "edit"
            ? ["OLD_4", "NEW_4"]
            : [];
      for (const mode of ["off", "on", "border"] as const) {
        const harness = createToolPresentationHarness(registered(mode).get(fixture.name)!);
        const failure = result("UNCLASSIFIED_FAILURE", "Inspect destination before retrying.");
        for (const expanded of [false, true, false, true]) {
          harness.call(fixture.args, { expanded });
          harness.result(failure, { expanded, isError: true });
          const text = plain(harness.render(160));
          expect(text.match(/UNCLASSIFIED_FAILURE/gu) ?? []).toHaveLength(expanded ? 1 : 0);
          expect(text.match(/Inspect destination before retrying/gu) ?? []).toHaveLength(
            expanded ? 1 : 0,
          );
          expect(!expanded || sourceMarkers.every((marker) => text.includes(marker))).toBe(true);
        }
      }
    });
    test(`${fixture.name} tolerates malformed arguments and cancellation`, () => {
      const harness = createToolPresentationHarness(registered().get(fixture.name)!);
      harness.call({ path: 17, command: false, edits: [null] }, { expanded: true });
      harness.result(result("Operation aborted"), { expanded: true, isError: true });
      expect(() => harness.render(20)).not.toThrow();
    });
  }
  test("write diff retains independent raw-result instructions", () => {
    const harness = createToolPresentationHarness(registered().get("write")!, {
      state: { codePreviewWriteBeforeSnapshot: { content: "OLD_SOURCE" } },
    });
    harness.call({ path: "source.ts", content: "NEW_SOURCE" }, { expanded: true });
    harness.result(
      result("Successfully wrote 10 bytes to source.ts\nVerify the remote copy before retrying."),
      { expanded: true },
    );
    const text = plain(harness.render(120));
    expect(text).toContain("OLD_SOURCE");
    expect(text).toContain("NEW_SOURCE");
    expect(text).toContain("Verify the remote copy before retrying.");
  });
  test("unverified write size evidence retains attention and raw result on expansion", () => {
    const harness = createToolPresentationHarness(registered().get("write")!);
    const args = { path: "source.ts", content: "NEW_SOURCE" };
    const output = result("WRITE_RECEIPT\nVerify destination before retrying.");
    output.details = {
      codePreviewBeforeWrite: {
        kind: "skipped",
        reason: "previous file too large",
        maxBytes: 10,
        byteLength: 20,
        sizeExceeded: false,
      },
    };
    harness.call(args);
    harness.result(output);
    expect(plain(harness.render(120))).toContain("cannot be previewed");
    harness.call(args, { expanded: true });
    harness.result(output, { expanded: true });
    const text = plain(harness.render(120));
    expect(text).toContain("NEW_SOURCE");
    expect(text).toContain("WRITE_RECEIPT");
    expect(text).toContain("Verify destination before retrying.");
    expect(text).not.toMatch(/new file/iu);
  });
  test("read leaves image bytes native and retains companion text in both styles", () => {
    for (const style of ["compact", "preview"] as const) {
      const harness = createToolPresentationHarness(registered("off", style).get("read")!);
      const image = { type: "image" as const, data: "NATIVE_IMAGE_BYTES", mimeType: "image/png" };
      const value = {
        content: [{ type: "text" as const, text: "image companion" }, image],
        details: {},
      };
      harness.call({ path: "photo.png" }, { expanded: true });
      harness.result(value, { expanded: true });
      const text = plain(harness.render());
      expect(text).toContain("image companion");
      expect(text).not.toContain(image.data);
      expect(value.content[1]).toBe(image);
    }
  });
});
