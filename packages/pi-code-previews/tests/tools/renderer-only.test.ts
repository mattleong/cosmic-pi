import type { AgentToolResult, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import { withCodePreviewRenderers } from "../../index";
import { createToolPresentationHarness, withPresentationSettings } from "../../testing";
import { resultText } from "../support/render";

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
              return new Text(resultText(value.content), 0, 0);
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
