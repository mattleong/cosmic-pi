import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { makeHostNotifier } from "../src/boundary/host-notifier.ts";

describe("subagent host notifier", () => {
  it("delivers a completed report immediately with Markdown structure preserved", () => {
    const sendMessage = vi.fn();
    const notify = makeHostNotifier({ sendMessage } as unknown as ExtensionAPI);

    notify({
      type: "completed",
      id: "agent-1",
      name: "reader",
      finalText: "## Read report\n\n- Complete.\n  - Nested.\n\n    const value = 1;",
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    const [message, options] = sendMessage.mock.calls[0] ?? [];
    expect(message).toMatchObject({
      customType: "pi-subagents-completed",
      display: true,
      content:
        "Background subagent reader (agent-1) completed.\n\n## Read report\n\n- Complete.\n  - Nested.\n\n    const value = 1;",
    });
    expect(message).not.toHaveProperty("details");
    expect(options).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("does not retain raw report secrets in custom-message metadata", () => {
    const sendMessage = vi.fn();
    const notify = makeHostNotifier({ sendMessage } as unknown as ExtensionAPI);

    notify({
      type: "completed",
      id: "agent-1",
      name: "reader",
      finalText: "password=hunter2",
    });

    const [message] = sendMessage.mock.calls[0] ?? [];
    expect(message.content).toContain("password=[REDACTED]");
    expect(message).not.toHaveProperty("details");
    expect(JSON.stringify(message)).not.toContain("hunter2");
  });
});
