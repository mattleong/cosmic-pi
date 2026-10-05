import type { AgentToolResult, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import { withCodePreviewRenderers } from "../../index";
import { createToolPresentationHarness, withPresentationSettings } from "../../testing";

it("uses captured style for self-shell preservation rather than newer global settings", () => {
  const raw: ToolRenderers = {
    renderShell: "self",
    renderCall: () => new Text("ORIGINAL CALL CONTENT", 0, 0),
    renderResult: () => new Text("COMPLETE RESULT CONTENT", 0, 0),
  };
  const result: AgentToolResult<unknown> = { content: [], details: {} };
  withPresentationSettings({ toolCallCollapsedStyle: "compact", toolCallTiming: false }, () => {
    const renderers = withCodePreviewRenderers({ name: "owned" }, raw, {
      collapsedStyle: "preview",
      selfShell: true,
    });
    const harness = createToolPresentationHarness(renderers);
    harness.call({});
    expect(harness.render().join("\n")).toContain("ORIGINAL CALL CONTENT");
  });
  withPresentationSettings({ toolCallCollapsedStyle: "preview", toolCallTiming: false }, () => {
    const renderers = withCodePreviewRenderers({ name: "owned" }, raw, {
      collapsedStyle: "compact",
      selfShell: true,
      compactSummary: () => ({ subject: "operation", outcome: "returned" }),
    });
    const harness = createToolPresentationHarness(renderers);
    harness.call({});
    harness.result(result);
    expect(harness.render().join("\n")).not.toContain("ORIGINAL CALL CONTENT");
    harness.call({}, { expanded: true });
    expect(harness.render().join("\n")).toContain("ORIGINAL CALL CONTENT");
    expect(harness.render().join("\n")).toContain("COMPLETE RESULT CONTENT");
  });
});

it("keeps inner call and result caches separate from the fixed background facade", () => {
  withPresentationSettings(
    { toolCallCollapsedStyle: "preview", toolCallBackground: "on", toolCallTiming: false },
    () => {
      let previousCall: Text | undefined;
      let previousResult: Text | undefined;
      const raw: ToolRenderers = {
        renderCall: (_args, _theme, context) => {
          expect(context.lastComponent).toBe(previousCall);
          previousCall = new Text("full call", 0, 0);
          return previousCall;
        },
        renderResult: (_value, _options, _theme, context) => {
          expect(context.lastComponent).toBe(previousResult);
          previousResult = new Text("full result", 0, 0);
          return previousResult;
        },
      };
      const renderers = withCodePreviewRenderers({ name: "cached" }, raw, { selfShell: true });
      const harness = createToolPresentationHarness(renderers);
      const frames = harness.cycle(
        {},
        { content: [], details: undefined },
        { invalidate: "after" },
      );
      for (const frame of frames) {
        expect(frame.text).toContain("full call");
        expect(frame.text).toContain("full result");
      }
    },
  );
});

for (const style of ["preview", "compact"] as const) {
  for (const mode of ["on", "off", "border"] as const) {
    it(`preserves renderer-only input and output with a fixed shell (${style}/${mode})`, () => {
      withPresentationSettings(
        { toolCallCollapsedStyle: style, toolCallBackground: mode, toolCallTiming: false },
        () => {
          const result: AgentToolResult<unknown> = {
            content: [
              { type: "text", text: "complete output and recovery /tmp/saved.txt" },
              { type: "image", data: "native-image", mimeType: "image/png" },
            ],
            details: undefined,
          };
          let observed: AgentToolResult<unknown> | undefined;
          const raw: ToolRenderers = {
            renderCall: (args) => new Text(JSON.stringify(args), 0, 0),
            renderResult: (value) => {
              observed = value;
              return new Text(
                value.content
                  .flatMap((part) => (part.type === "text" ? [part.text] : []))
                  .join("\n"),
                0,
                0,
              );
            },
          };
          const renderers = withCodePreviewRenderers({ name: "late-tool" }, raw, {
            selfShell: true,
            preserveSelfShell: false,
            compactSummary: () => ({ subject: "example", outcome: "returned" }),
          });
          expect(renderers.renderShell).toBe("self");
          const harness = createToolPresentationHarness(renderers, { width: 160 });
          const exactInput = "full multiline\nsource that must remain accessible";
          const frames = harness.cycle({ source: exactInput, other: "all arguments" }, result, {
            states: [true, false, true],
            invalidate: "after",
          });
          for (const frame of frames.filter((entry) => entry.expanded)) {
            expect(frame.text).toContain(JSON.stringify(exactInput));
            expect(frame.text).toContain("all arguments");
            expect(frame.text).toContain("/tmp/saved.txt");
          }
          expect(observed?.content).toBe(result.content);
          expect(result.content[1]).toEqual({
            type: "image",
            data: "native-image",
            mimeType: "image/png",
          });
        },
      );
    });
  }
}
