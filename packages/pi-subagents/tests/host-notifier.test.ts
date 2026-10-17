import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import { describe, expect, it, vi } from "vitest";
import {
  hostNotifier,
  type SubagentCompletionNotification,
} from "../src/boundary/host-notifier.ts";
import { extensionApiFixture } from "pi-cosmic-core/testing";

type SendMessage = ExtensionAPI["sendMessage"];

const messageContent = (content: Parameters<SendMessage>[0]["content"] | undefined): string =>
  Predicate.isString(content) ? content : JSON.stringify(content);

const notifier = (sendMessage = vi.fn<SendMessage>()) => ({
  sendMessage,
  notify: hostNotifier(extensionApiFixture({ sendMessage })),
  content: (call = 0) => messageContent(sendMessage.mock.calls[call]?.[0].content),
});

const completion = (
  id: string,
  name: string,
  extra: Partial<SubagentCompletionNotification> = {},
): SubagentCompletionNotification => ({ id, name, generation: 1, outcome: "completed", ...extra });

const steer = { deliverAs: "steer", triggerTurn: true };

describe("subagent host notifier", () => {
  it("steers a completed report into the active orchestration run", () => {
    const { sendMessage, notify, content } = notifier();
    const finalText = "## Read report\n\n- Complete.\n  - Nested.\n\n    const value = 1;";

    notify({ type: "completed", runs: [completion("agent-1", "reader", { finalText })] });

    expect(sendMessage).toHaveBeenCalledOnce();
    const [message, options] = sendMessage.mock.calls[0] ?? [];
    expect(message).toMatchObject({ customType: "pi-subagents-completed", display: true });
    expect(content()).toContain("agent-1");
    expect(content()).toContain(finalText);
    expect(JSON.stringify(message?.details)).not.toContain("Read report");
    expect(options).toEqual(steer);
  });

  it("chunks large completion batches without losing later run IDs", () => {
    const { sendMessage, notify, content } = notifier();
    const finalText = "x".repeat(32 * 1024);

    const delivery = notify({
      type: "completed",
      runs: [
        completion("agent-1", "reader", { finalText }),
        completion("agent-2", "tester", { finalText }),
      ],
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(content(0).length).toBeLessThanOrEqual(32 * 1024);
    expect(content(1).length).toBeLessThanOrEqual(32 * 1024);
    expect(content(0)).toContain("agent-1");
    expect(content(1)).toContain("agent-2");
    expect(delivery?.deliveredCompletionKeys).toEqual(["agent-1:1", "agent-2:1"]);
  });

  it("acknowledges only the first chunk when the second send accepts then throws", () => {
    let sendOrdinal = 0;
    const { sendMessage, notify } = notifier(
      vi.fn<SendMessage>(() => {
        sendOrdinal += 1;
        if (sendOrdinal === 2) throw new Error("accepted before host callback threw");
      }),
    );
    const finalText = "x".repeat(32 * 1024);
    const runs = [
      completion("agent-1", "reader", { finalText }),
      completion("agent-2", "tester", { finalText }),
    ];

    expect(notify({ type: "completed", runs })?.deliveredCompletionKeys).toEqual(["agent-1:1"]);
    expect(notify({ type: "completed", runs: [runs[1]!] })?.deliveredCompletionKeys).toEqual([
      "agent-2:1",
    ]);
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  it("does not retain raw outcome secrets in custom-message metadata", () => {
    const { sendMessage, notify, content } = notifier();

    notify({
      type: "completed",
      runs: [
        completion("agent-1", "reader", { finalText: "password=hunter2" }),
        completion("agent-2", "tester", {
          outcome: "failed",
          error: "token=terminal-secret",
          warning: "api_key=warning-secret",
        }),
      ],
    });

    const [message] = sendMessage.mock.calls[0] ?? [];
    expect(content()).toContain("password=[REDACTED]");
    expect(content()).toContain("token=[REDACTED]");
    expect(content()).toContain("api_key=[REDACTED]");
    expect(JSON.stringify(message)).not.toContain("hunter2");
    expect(JSON.stringify(message)).not.toContain("terminal-secret");
    expect(JSON.stringify(message)).not.toContain("warning-secret");
  });
});
