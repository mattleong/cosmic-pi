import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { createToolPresentationHarness } from "pi-code-previews/testing";
import {
  codePreviewSettings,
  setCodePreviewSettings,
} from "../../../pi-code-previews/src/config/state.ts";
import { buildMcpTool, wrapMcpTool } from "../../src/tools/controller.ts";
import { makeMcpErrorReceipts } from "../../src/boundary/host-tool-result.ts";

const settings = { ...codePreviewSettings };
afterEach(() => setCodePreviewSettings(settings));
// SAFETY: All rendering style operations are supplied by this fixture.
const theme = {
  fg: (_key: string, value: string) => value,
  bg: (_key: string, value: string) => value,
  bold: (value: string) => value,
} as Theme;
const actions = [
  "status",
  "connect",
  "disconnect",
  "refresh",
  "server.instructions",
  "completion.complete",
  "events.read",
  "resources.subscribe",
  "resources.unsubscribe",
  "resources.subscriptions",
  "tools.list",
  "tools.search",
  "tools.describe",
  "tools.call",
  "resources.list",
  "resources.templates",
  "resources.read",
  "prompts.list",
  "prompts.get",
  "result.read",
];

it("keeps registered action results expandable in every shell and preserves attachments and original data", () => {
  for (const mode of ["on", "off", "border"] as const) {
    for (const style of ["compact", "preview"] as const) {
      setCodePreviewSettings({
        ...settings,
        toolCallBackground: mode,
        toolCallCollapsedStyle: style,
        toolCallTiming: false,
      });
      const tool = wrapMcpTool(
        buildMcpTool({
          owner: Symbol(),
          receipts: makeMcpErrorReceipts(),
          execute: () => Promise.reject(new Error("not executed")),
        }),
      );
      for (const action of actions) {
        const args = { action, server: "catalog", tool: "inspect", id: "saved" };
        const data =
          action === "result.read"
            ? {
                text: "body-marker",
                offset: 0,
                next: null,
                total: 11,
                origin: { action: "tools.call", outcome: "completed", isError: false },
              }
            : {
                result: {
                  value: "body-marker",
                  attachments: [{ index: 0, mimeType: "image/png" }],
                },
              };
        const result = {
          content: [{ type: "image" as const, data: "native-image-bytes", mimeType: "image/png" }],
          details: { action, outcome: "completed", isError: false, notices: [], data },
        };
        const before = structuredClone(result);
        const harness = createToolPresentationHarness(tool, { theme });
        harness.call(args, { executionStarted: false, isPartial: true });
        expect(harness.render(200).join("\n")).toContain(action);
        harness.call(args, { executionStarted: true, isPartial: true });
        harness.result(result, { isPartial: true });
        for (const expanded of [false, true, false, true]) {
          harness.call(args, { expanded, isPartial: false });
          harness.result(result, { expanded });
          harness.invalidate();
          const text = harness.render(200).join("\n");
          if (expanded) {
            expect(text).toContain("body-marker");
            if (style === "compact") expect(text.split(action).length - 1).toBe(1);
          } else if (style === "compact") expect(text).not.toContain("body-marker");
        }
        expect(result).toEqual(before);
      }
    }
  }
});
