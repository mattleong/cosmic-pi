import { describe, expect, it, vi } from "vitest";
import { makeHostNotifier } from "../src/boundary/host-notifier.ts";
import { extensionApiFixture } from "./fixtures/pi-host.ts";

describe("subagent host notifier", () => {
  it("steers a completed report into the active orchestration run", () => {
    const sendMessage = vi.fn();
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const notify = makeHostNotifier(extensionApiFixture({ sendMessage }));

    notify({
      type: "completed",
      runs: [
        {
          id: "agent-1",
          name: "reader",
          generation: 1,
          outcome: "completed" as const,
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
    expect(JSON.stringify(message.details)).not.toContain("Read report");
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  it("wakes the parent once for a retained report generation", () => {
    const sendMessage = vi.fn();
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const notify = makeHostNotifier(extensionApiFixture({ sendMessage }));
    const notification = {
      type: "completed" as const,
      runs: [
        {
          id: "agent-1",
          name: "reader",
          generation: 2,
          outcome: "completed" as const,
          finalText: "Follow-up report.",
          retained: true,
        },
      ],
    };

    expect(notify(notification)?.deliveredCompletionKeys).toEqual(["agent-1:2"]);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[0].content).toContain(
      "reported generation 2 and remains available for guidance",
    );
    expect(sendMessage.mock.calls[0]?.[0].content).toContain("Follow-up report.");
    expect(sendMessage.mock.calls[0]?.[1]).toEqual({
      deliverAs: "steer",
      triggerTurn: true,
    });
  });

  it("delivers failures and folded warnings through the coalesced outcome channel", () => {
    const sendMessage = vi.fn();
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const notify = makeHostNotifier(extensionApiFixture({ sendMessage }));

    notify({
      type: "completed",
      runs: [
        {
          id: "agent-1",
          name: "reader",
          generation: 1,
          outcome: "failed",
          error: "Process exited unexpectedly.",
          warning:
            "System warning: Ownership remains quarantined.\nChild warning: Validation was incomplete.",
        },
      ],
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      customType: "pi-subagents-completed",
      content:
        "Background subagent reader (agent-1) failed.\n\nError: Process exited unexpectedly.\n\nWarning: System warning: Ownership remains quarantined.\nChild warning: Validation was incomplete.",
    });
    expect(sendMessage.mock.calls[0]?.[1]).toEqual({
      deliverAs: "steer",
      triggerTurn: true,
    });
  });

  it("directs failed profiled runs through remaining candidates before generalist", () => {
    const sendMessage = vi.fn();
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const notify = makeHostNotifier(extensionApiFixture({ sendMessage }));

    notify({
      type: "completed",
      runs: [
        {
          id: "agent-7",
          name: "reviewer",
          generation: 1,
          outcome: "failed",
          error: "Claude usage exhausted.",
          profile: "reviewer",
          retryAvailable: true,
          remainingCandidateCount: 2,
        },
      ],
    });

    const content = sendMessage.mock.calls[0]?.[0].content ?? "";
    expect(content).toContain("2 configured reviewer candidates remain");
    expect(content).toContain('subagent_lifecycle({ action: "retry", runIds: ["agent-7"] })');
    expect(content).toContain("before launching any generalist replacement");
  });

  it("names the exact reply tool when a subagent asks a parent question", () => {
    const sendMessage = vi.fn();
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const notify = makeHostNotifier(extensionApiFixture({ sendMessage }));

    const delivery = notify({
      type: "question",
      id: "agent-7",
      name: "reviewer",
      requestId: "question-1",
      message: "Should I update the fixture?",
      generation: 1,
    });

    expect(delivery?.actionAccepted).toBe(true);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[0].content).toContain(
      'subagent_reply({ runId: "agent-7", message: "..." })',
    );
    expect(sendMessage.mock.calls[0]?.[0].content).toContain("then call subagent_await again");
    expect(sendMessage.mock.calls[0]?.[0].content).not.toContain("subagent({ action:");
    expect(sendMessage.mock.calls[0]?.[1]).toEqual({
      deliverAs: "steer",
      triggerTurn: true,
    });
  });

  it("explains a single completion without a final report", () => {
    const sendMessage = vi.fn();
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const notify = makeHostNotifier(extensionApiFixture({ sendMessage }));

    notify({
      type: "completed",
      runs: [{ id: "agent-1", name: "reader", generation: 1, outcome: "completed" as const }],
    });

    expect(sendMessage.mock.calls[0]?.[0].content).toContain("Completed without a final report.");
  });

  it("coalesces completion rendering", () => {
    const sendMessage = vi.fn();
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const notify = makeHostNotifier(extensionApiFixture({ sendMessage }));
    const runs = [
      {
        id: "agent-1",
        name: "reader",
        generation: 1,
        outcome: "completed" as const,
        finalText: "Read.",
      },
      {
        id: "agent-2",
        name: "tester",
        generation: 1,
        outcome: "completed" as const,
        finalText: "Tested.",
      },
    ];

    notify({ type: "completed", runs });

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[0].content).toContain(
      "2 background subagents finished · 2 completed",
    );
    expect(sendMessage.mock.calls[0]?.[0].content).toContain("## reader (agent-1)");
    expect(sendMessage.mock.calls[0]?.[0].content).toContain("## tester (agent-2)");
  });

  it("distinguishes completed, failed, and retained outcomes in batch headers", () => {
    const sendMessage = vi.fn();
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const notify = makeHostNotifier(extensionApiFixture({ sendMessage }));
    notify({
      type: "completed",
      runs: [
        {
          id: "agent-1",
          name: "reader",
          generation: 1,
          outcome: "completed" as const,
          finalText: "Read.",
        },
        {
          id: "agent-2",
          name: "reviewer",
          generation: 2,
          outcome: "completed" as const,
          finalText: "Reviewed.",
          retained: true,
        },
        {
          id: "agent-3",
          name: "tester",
          generation: 1,
          outcome: "failed",
          error: "Tests failed.",
        },
      ],
    });
    expect(sendMessage.mock.calls[0]?.[0].content).toContain(
      "3 background subagents finished · 1 completed · 1 failed · 1 reported and retained",
    );
  });

  it("chunks large completion batches without losing later run IDs", () => {
    const sendMessage = vi.fn();
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const notify = makeHostNotifier(extensionApiFixture({ sendMessage }));
    const report = "x".repeat(32 * 1024);

    const delivery = notify({
      type: "completed",
      runs: [
        {
          id: "agent-1",
          name: "reader",
          generation: 1,
          outcome: "completed" as const,
          finalText: report,
        },
        {
          id: "agent-2",
          name: "tester",
          generation: 1,
          outcome: "completed" as const,
          finalText: report,
        },
      ],
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[0].content.length).toBeLessThanOrEqual(32 * 1024);
    expect(sendMessage.mock.calls[1]?.[0].content.length).toBeLessThanOrEqual(32 * 1024);
    expect(sendMessage.mock.calls[0]?.[0].content).toContain("agent-1");
    expect(sendMessage.mock.calls[1]?.[0].content).toContain("agent-2");
    expect(sendMessage.mock.calls[1]?.[0].content).toContain("(continued 2)");
    expect(sendMessage.mock.calls[1]?.[0].content).toContain(
      "[Report truncated; use subagent_status or subagent_await for agent-2.]",
    );
    expect(delivery?.deliveredCompletionKeys).toEqual(["agent-1:1", "agent-2:1"]);
  });

  it("acknowledges only the first chunk when the second send accepts then throws", () => {
    let sendOrdinal = 0;
    const sendMessage = vi.fn((): void => {
      sendOrdinal += 1;
      if (sendOrdinal === 2) throw new Error("accepted before host callback threw");
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const notify = makeHostNotifier(extensionApiFixture({ sendMessage }));
    const report = "x".repeat(32 * 1024);
    const runs = [
      {
        id: "agent-1",
        name: "reader",
        generation: 1,
        outcome: "completed" as const,
        finalText: report,
      },
      {
        id: "agent-2",
        name: "tester",
        generation: 1,
        outcome: "completed" as const,
        finalText: report,
      },
    ];

    expect(notify({ type: "completed", runs })?.deliveredCompletionKeys).toEqual(["agent-1:1"]);
    expect(notify({ type: "completed", runs: [runs[1]!] })?.deliveredCompletionKeys).toEqual([
      "agent-2:1",
    ]);
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  it("does not retain raw outcome secrets in custom-message metadata", () => {
    const sendMessage = vi.fn();
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const notify = makeHostNotifier(extensionApiFixture({ sendMessage }));

    notify({
      type: "completed",
      runs: [
        {
          id: "agent-1",
          name: "reader",
          generation: 1,
          outcome: "completed" as const,
          finalText: "password=hunter2",
        },
        {
          id: "agent-2",
          name: "tester",
          generation: 1,
          outcome: "failed",
          error: "token=terminal-secret",
          warning: "api_key=warning-secret",
        },
      ],
    });

    const [message] = sendMessage.mock.calls[0] ?? [];
    expect(message.content).toContain("password=[REDACTED]");
    expect(message.content).toContain("token=[REDACTED]");
    expect(message.content).toContain("api_key=[REDACTED]");
    expect(JSON.stringify(message)).not.toContain("hunter2");
    expect(JSON.stringify(message)).not.toContain("terminal-secret");
    expect(JSON.stringify(message)).not.toContain("warning-secret");
  });
});
