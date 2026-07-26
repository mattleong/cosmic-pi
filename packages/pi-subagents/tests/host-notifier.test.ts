import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { makeHostNotifier } from "../src/boundary/host-notifier.ts";

describe("subagent host notifier", () => {
  it("steers a completed report into the active orchestration run", () => {
    const sendMessage = vi.fn();
    const notify = makeHostNotifier({ sendMessage } as unknown as ExtensionAPI);

    notify({
      type: "completed",
      runs: [
        {
          id: "agent-1",
          name: "reader",
          generation: 1,
          finalText: "## Read report\n\n- Complete.\n  - Nested.\n\n    const value = 1;",
        },
      ],
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
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  it("keeps routine progress out of model context and steers warnings", () => {
    const sendMessage = vi.fn();
    const notify = makeHostNotifier({ sendMessage } as unknown as ExtensionAPI);

    notify({
      type: "progress",
      id: "agent-1",
      name: "reader",
      message: "Found the boundary.",
      triggerTurn: true,
    });
    notify({
      type: "warning",
      id: "agent-1",
      name: "reader",
      message: "Later warning.",
      triggerTurn: false,
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[1]).toEqual({
      deliverAs: "steer",
      triggerTurn: false,
    });
  });

  it("coalesces completion rendering and deduplicates generations", () => {
    const sendMessage = vi.fn();
    const notify = makeHostNotifier({ sendMessage } as unknown as ExtensionAPI);
    const runs = [
      { id: "agent-1", name: "reader", generation: 1, finalText: "Read." },
      { id: "agent-2", name: "tester", generation: 1, finalText: "Tested." },
    ];

    notify({ type: "completed", runs });
    notify({ type: "completed", runs });

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[0].content).toContain("2 background subagents completed");
    expect(sendMessage.mock.calls[0]?.[0].content).toContain("## reader (agent-1)");
    expect(sendMessage.mock.calls[0]?.[0].content).toContain("## tester (agent-2)");
  });

  it("does not retain raw report secrets in custom-message metadata", () => {
    const sendMessage = vi.fn();
    const notify = makeHostNotifier({ sendMessage } as unknown as ExtensionAPI);

    notify({
      type: "completed",
      runs: [{ id: "agent-1", name: "reader", generation: 1, finalText: "password=hunter2" }],
    });

    const [message] = sendMessage.mock.calls[0] ?? [];
    expect(message.content).toContain("password=[REDACTED]");
    expect(message).not.toHaveProperty("details");
    expect(JSON.stringify(message)).not.toContain("hunter2");
  });
});
