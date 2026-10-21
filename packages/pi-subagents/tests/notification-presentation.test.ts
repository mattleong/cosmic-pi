import { applyPresentationSettings, captureRegistrations } from "pi-code-previews/testing";
import { extensionApiFixture, plainTheme } from "pi-cosmic-core/testing";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import {
  registerSubagentMessageRenderers,
  renderSubagentMessage,
} from "../src/application/messages.ts";
import { hostNotifier } from "../src/boundary/host-notifier.ts";

let restore = () => {};
afterEach(() => restore());

test.each(["compact"] as const)(
  "registered %s notifications hide agent procedures without changing their delivered content",
  (style) => {
    restore = applyPresentationSettings({ toolCallCollapsedStyle: style });
    const renderers = captureRegistrations(registerSubagentMessageRenderers).messageRenderers;
    const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
    const notify = hostNotifier(extensionApiFixture({ sendMessage }));
    notify({
      type: "completed",
      runs: [
        {
          id: "PRIVATE_RUN_ID",
          name: "Worker",
          generation: 1,
          outcome: "failed",
          error: "PRIVATE_STACK_TRACE",
          nextCandidate: { runtime: "pi", model: "openai/next", effort: "high" },
        },
        {
          id: "PRIVATE_RUN_ID_WRITER",
          name: "Writer",
          generation: 1,
          outcome: "completed",
          finalText: "Done.",
          workspaceOutcome: { status: "proposal", changedFileCount: 2 },
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
      expect(renderers.has(message.customType)).toBe(true);
      const render = renderSubagentMessage;
      expect(message.content).toContain("PRIVATE_RUN_ID");
      for (const expanded of [false, true, false, true]) {
        const component = render(
          { ...message, role: "custom", timestamp: 0 },
          { expanded, outputPad: 0 },
          plainTheme,
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
        if (!expanded) expect(text).not.toMatch(/agent_send|agent_lifecycle|agent_worktree/);
        expect(JSON.stringify(message)).toBe(before);
      }
      const history = render(
        { ...message, details: undefined, role: "custom", timestamp: 0 },
        { expanded: true, outputPad: 0 },
        plainTheme,
      );
      expect(history!.render(180).join("\n")).toContain("PRIVATE_RUN_ID");
    }
  },
);
