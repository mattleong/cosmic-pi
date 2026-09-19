import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { registerSubagentMessageRenderers } from "../src/application/messages.ts";
import { makeHostNotifier } from "../src/boundary/host-notifier.ts";
import { extensionApiFixture } from "./fixtures/pi-host.ts";
import {
  codePreviewSettings,
  setCodePreviewSettings,
} from "../../pi-code-previews/src/config/state.ts";

const initial = { ...codePreviewSettings };
afterEach(() => setCodePreviewSettings(initial));
// SAFETY: Only text styling is used by these registered render callbacks.
const theme = { fg: (_color: string, text: string) => text } as Theme;

test("registered worker notifications hide agent procedures without changing their delivered content", () => {
  setCodePreviewSettings({ ...initial, toolCallCollapsedStyle: "compact" });
  const renderers = new Map<string, Parameters<ExtensionAPI["registerMessageRenderer"]>[1]>();
  const sendMessage = vi.fn();
  const pi = extensionApiFixture({
    sendMessage,
    registerMessageRenderer: (
      type: string,
      renderer: Parameters<ExtensionAPI["registerMessageRenderer"]>[1],
    ) => renderers.set(type, renderer),
  });
  registerSubagentMessageRenderers(pi);
  const notify = makeHostNotifier(pi);
  notify({
    type: "completed",
    runs: [
      {
        id: "PRIVATE_RUN_ID",
        name: "Worker",
        generation: 1,
        outcome: "failed",
        error: "PRIVATE_STACK_TRACE",
        retryAvailable: true,
      },
    ],
  });
  notify({
    type: "question",
    id: "PRIVATE_RUN_ID",
    name: "Worker",
    requestId: "PRIVATE_REQUEST",
    generation: 1,
    message: "AGENT_QUESTION",
  });
  for (const [message] of sendMessage.mock.calls) {
    const before = JSON.stringify(message);
    const render = renderers.get(message.customType)!;
    expect(message.content).toContain("PRIVATE_RUN_ID");
    for (const expanded of [false, true, false, true]) {
      const component = render(
        { ...message, role: "custom", timestamp: 0 },
        { expanded, outputPad: 0 },
        theme,
      );
      const text = component!.render(180).join("\n");
      expect(text.includes("PRIVATE_RUN_ID")).toBe(expanded);
      expect(
        text.includes(
          message.customType === "pi-subagents-completed"
            ? "PRIVATE_STACK_TRACE"
            : "AGENT_QUESTION",
        ),
      ).toBe(expanded);
      if (!expanded) expect(text).not.toMatch(/subagent_reply|subagent_lifecycle/);
      expect(JSON.stringify(message)).toBe(before);
    }
    const history = render(
      { ...message, details: undefined, role: "custom", timestamp: 0 },
      { expanded: true, outputPad: 0 },
      theme,
    );
    expect(history!.render(180).join("\n")).toContain("PRIVATE_RUN_ID");
  }
});
