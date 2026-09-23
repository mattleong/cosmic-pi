import { afterEach, describe, expect, test } from "vitest";
import type {
  ExtensionAPI,
  ToolDefinition,
  AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createToolPresentationHarness } from "../../testing";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { registerToolRenderers } from "../../src/tools/renderers/registration";
import { ALL_CODE_PREVIEW_TOOLS } from "../../src/tools/names";
import { stripAnsi, testTheme } from "../support/render";

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
    readContentPreview: false,
    writeContentPreview: false,
    editDiffPreview: false,
    grepResultPreview: false,
    findResultPreview: false,
    lsResultPreview: false,
  });
  const tools = new Map<string, ToolDefinition>();
  // SAFETY: This fixture implements the two registration boundary methods used here.
  const api = {
    getAllTools: () => [],
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
  };
  // SAFETY: Registration only calls getAllTools and registerTool on this fixture.
  registerToolRenderers(api as typeof api & ExtensionAPI, "/project", { toolOptions: {} });
  return tools;
}
function result(text: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: {} };
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
        const harness = createToolPresentationHarness(tool, {
          theme: Object.assign(testTheme(), { bg: (_color: string, text: string) => text }),
          cwd: "/project",
        });
        harness.call(fixture.args);
        harness.result(result(fixture.output));
        for (const expanded of [true, false, true]) {
          harness.call(fixture.args, { expanded });
          harness.result(result(fixture.output), { expanded });
          const text = plain(harness.render(100));
          expect(!expanded || text.includes(fixture.retained)).toBe(true);
          for (const width of [16, 40])
            expect(harness.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
          harness.invalidate();
        }
      }
    });
    test(`${fixture.name} retains raw unknown errors once and keeps failure call source`, () => {
      const harness = createToolPresentationHarness(registered().get(fixture.name)!, {
        theme: Object.assign(testTheme(), { bg: (_color: string, text: string) => text }),
      });
      harness.call(fixture.args, { expanded: true });
      harness.result(result("UNCLASSIFIED_FAILURE\nInspect destination before retrying."), {
        expanded: true,
        isError: true,
      });
      const text = plain(harness.render(160));
      expect(text.match(/UNCLASSIFIED_FAILURE/gu)).toHaveLength(1);
      expect(text.match(/Inspect destination before retrying/gu)).toHaveLength(1);
      const sourceMarkers =
        fixture.name === "bash"
          ? ["LAST_COMMAND"]
          : fixture.name === "edit"
            ? ["OLD_4", "NEW_4"]
            : [];
      expect(sourceMarkers.every((marker) => text.includes(marker))).toBe(true);
    });
    test(`${fixture.name} tolerates malformed arguments and cancellation`, () => {
      const harness = createToolPresentationHarness(registered().get(fixture.name)!, {
        theme: Object.assign(testTheme(), { bg: (_color: string, text: string) => text }),
      });
      harness.call({ path: 17, command: false, edits: [null] }, { expanded: true });
      harness.result(result("Operation aborted"), { expanded: true, isError: true });
      expect(() => harness.render(20)).not.toThrow();
    });
  }
  test("write diff retains independent raw-result instructions", () => {
    const harness = createToolPresentationHarness(registered().get("write")!, {
      theme: testTheme(),
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
    const harness = createToolPresentationHarness(registered().get("write")!, {
      theme: testTheme(),
    });
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
  test("unknown write history never asserts a new file", () => {
    const harness = createToolPresentationHarness(registered().get("write")!, {
      theme: Object.assign(testTheme(), { bg: (_color: string, text: string) => text }),
    });
    const fixture = cases[2];
    harness.call(fixture.args, { expanded: true });
    harness.result(result(fixture.output), { expanded: true });
    expect(plain(harness.render())).not.toMatch(/new file/iu);
  });
  test("read leaves image bytes native and retains companion text in both styles", () => {
    for (const style of ["compact", "preview"] as const) {
      const harness = createToolPresentationHarness(registered("off", style).get("read")!, {
        theme: Object.assign(testTheme(), { bg: (_color: string, text: string) => text }),
      });
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
