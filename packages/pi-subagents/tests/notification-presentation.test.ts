import { applyPresentationSettings, captureRegistrations } from "pi-code-previews/testing";
import { plainTheme } from "pi-cosmic-core/testing";
import { afterEach, expect, test, vi } from "vitest";
import { registerSubagentMessageRenderers } from "../src/application/messages.ts";
import { makeHostNotifier } from "../src/boundary/host-notifier.ts";
import { extensionApiFixture } from "./fixtures/pi-host.ts";

let restore = () => {};
afterEach(() => restore());

test.each(["compact", "preview"] as const)(
  "registered %s notifications hide agent procedures without changing their delivered content",
  (style) => {
    restore = applyPresentationSettings({ toolCallCollapsedStyle: style });
    const renderers = captureRegistrations(registerSubagentMessageRenderers).messageRenderers;
    const sendMessage = vi.fn();
    const notify = makeHostNotifier(extensionApiFixture({ sendMessage }));
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
          plainTheme,
        );
        const text = component!.render(180).join("\n");
        expect(text.includes("PRIVATE_RUN_ID")).toBe(expanded);
        // Collapsed, the row names the subagent in one plain line.
        if (!expanded) expect(text).toContain("Worker");
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
        plainTheme,
      );
      expect(history!.render(180).join("\n")).toContain("PRIVATE_RUN_ID");
    }
  },
);

test("forwarded and peer notices without a recorded outcome stay neutral", () => {
  restore = applyPresentationSettings({ toolCallCollapsedStyle: "compact" });
  const renderers = captureRegistrations(registerSubagentMessageRenderers).messageRenderers;
  for (const customType of ["pi-subagents-proxy-notification", "pi-subagents-peer-notice"]) {
    const text = renderers.get(customType)!(
      {
        role: "custom",
        customType,
        content: "Subagent PRIVATE_RUN_ID completed.",
        display: true,
        timestamp: 0,
      },
      { expanded: false, outputPad: 0 },
      plainTheme,
    )!
      .render(120)
      .join("\n");
    // Neither a success nor an unconfirmed outcome is claimed for a notice.
    expect(text).not.toMatch(/^[✓?✗⚠]/u);
    expect(text).not.toContain("PRIVATE_RUN_ID");
  }
});
