import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import { describe, expect, it, vi } from "vitest";
import {
  hostNotifier,
  type SubagentCompletionNotification,
} from "../src/boundary/host-notifier.ts";
import { extensionApiFixture } from "pi-cosmic-core/testing";
import { MAX_COMPLETION_DELIVERY_BATCH, MAX_NOTIFICATION_CHARS } from "../src/run/limits.ts";

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
    const finalText = "## Read report\n\n- Complete.";

    notify({ type: "completed", runs: [completion("agent-1", "reader", { finalText })] });

    expect(sendMessage).toHaveBeenCalledOnce();
    const [message, options] = sendMessage.mock.calls[0] ?? [];
    expect(message).toMatchObject({ customType: "pi-subagents-completed", display: true });
    expect(content()).toContain("agent-1");
    expect(content()).toContain("Read report");
    expect(JSON.stringify(message?.details)).not.toContain("Read report");
    expect(options).toEqual(steer);
  });

  it("sends a full batch as one bounded notice that names every run", () => {
    const { sendMessage, notify, content } = notifier();
    const finalText = "x".repeat(32 * 1024);
    const runs = Array.from({ length: MAX_COMPLETION_DELIVERY_BATCH }, (_, index) =>
      completion(`agent-${index}`, `reader-${index}`, { finalText }),
    );

    const delivery = notify({ type: "completed", runs });

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(content().length).toBeLessThanOrEqual(MAX_NOTIFICATION_CHARS);
    for (const run of runs) expect(content()).toContain(`${run.id} ${run.name}`);
    expect(delivery?.deliveredCompletionKeys).toEqual(runs.map((run) => `${run.id}:1`));
  });

  it("acknowledges nothing when the send throws, so the batch is retried whole", () => {
    let sendOrdinal = 0;
    const { sendMessage, notify } = notifier(
      vi.fn<SendMessage>(() => {
        sendOrdinal += 1;
        if (sendOrdinal === 1) throw new Error("accepted before host callback threw");
      }),
    );
    const runs = [completion("agent-1", "reader"), completion("agent-2", "tester")];

    expect(notify({ type: "completed", runs })?.deliveredCompletionKeys).toEqual([]);
    expect(notify({ type: "completed", runs })?.deliveredCompletionKeys).toEqual([
      "agent-1:1",
      "agent-2:1",
    ]);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("names a proposal's workspace and line totals, leaving its files to agent_read", () => {
    const { notify, content } = notifier();
    notify({
      type: "completed",
      runs: [
        completion("agent-1", "writer", {
          workspaceId: "ws-1",
          workspaceOutcome: {
            status: "proposal",
            changedFileCount: 3,
            diffStat: {
              addedLines: 12,
              deletedLines: 4,
              files: [
                { path: "src/session.ts", addedLines: 10, deletedLines: 4 },
                { path: "assets/logo.png", addedLines: 0, deletedLines: 0, binary: true },
              ],
            },
          },
        }),
      ],
    });
    const text = content();
    for (const evidence of ["ws-1", "+12", "−4"]) expect(text).toContain(evidence);
    expect(text).not.toContain("src/session.ts");
  });

  it("tells the parent how a worktree writer's workspace ended, even when the report is clipped", () => {
    const { notify, content } = notifier();
    const proposal = { status: "proposal", changedFileCount: 3, uncapturedFileCount: 1 } as const;

    notify({
      type: "completed",
      runs: [
        completion("agent-1", "writer", { workspaceId: "ws-1", workspaceOutcome: proposal }),
        completion("agent-2", "idle-writer", {
          workspaceId: "ws-2",
          workspaceOutcome: { status: "auto-discarded" },
        }),
        completion("agent-3", "reader"),
        completion("agent-4", "settling-writer", { workspaceId: "ws-4" }),
      ],
    });
    const sections = content().split("\n\n").slice(1);
    expect(sections.map((section) => section.includes("agent_worktree"))).toEqual([
      true,
      false,
      false,
      true,
    ]);
    expect(sections[3]).toContain("ws-4");
    const quiet = notifier();
    quiet.notify({
      type: "completed",
      runs: [
        completion("agent-2", "idle-writer", {
          workspaceId: "ws-2",
          workspaceOutcome: { status: "auto-discarded" },
        }),
      ],
    });
    const plain = notifier();
    plain.notify({ type: "completed", runs: [completion("agent-2", "idle-writer")] });
    expect(quiet.content()).not.toBe(plain.content());

    const clipped = notifier();
    clipped.notify({
      type: "completed",
      runs: [
        completion("agent-1", "writer", {
          finalText: "x".repeat(40 * 1024),
          workspaceId: "ws-1",
          workspaceOutcome: proposal,
        }),
      ],
    });
    expect(clipped.content().length).toBeLessThanOrEqual(MAX_NOTIFICATION_CHARS);
    expect(clipped.content()).toContain("agent_worktree");
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
