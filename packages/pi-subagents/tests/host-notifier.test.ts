import { describe, expect, it, vi } from "vitest";
import {
  makeHostNotifier,
  type SubagentCompletionNotification,
} from "../src/boundary/host-notifier.ts";
import { extensionApiFixture } from "./fixtures/pi-host.ts";

const notifier = (sendMessage = vi.fn()) => ({
  sendMessage,
  notify: makeHostNotifier(extensionApiFixture({ sendMessage })),
  content: (call = 0) => String(sendMessage.mock.calls[call]?.[0].content),
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
    expect(JSON.stringify(message.details)).not.toContain("Read report");
    expect(options).toEqual(steer);
  });

  it("keeps a recorded warning when a report quotes the same words without a warning identity", () => {
    const { notify, content } = notifier();
    notify({
      type: "completed",
      runs: [
        completion("agent-1", "writer", {
          finalText: "Warning: Check write state before retrying.",
          warning: "Check write state before retrying.",
        }),
      ],
    });
    expect(content().split("Check write state before retrying.")).toHaveLength(3);
  });

  it("delivers failures and folded warnings through the coalesced outcome channel", () => {
    const { sendMessage, notify, content } = notifier();
    const warning =
      "System warning: Ownership remains quarantined.\nChild warning: Validation was incomplete.";

    notify({
      type: "completed",
      runs: [
        completion("agent-1", "reader", {
          outcome: "failed",
          error: "Process exited unexpectedly.",
          warning,
        }),
      ],
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ customType: "pi-subagents-completed" });
    expect(content()).toContain("agent-1");
    expect(content()).toContain("Process exited unexpectedly.");
    expect(content()).toContain(warning);
  });

  it("labels a failure once, even when the worker's error names its own class", () => {
    for (const error of ["Error: 429 Too Many Requests", "TypeError: bad input", "exit 1"]) {
      const { notify, content } = notifier();
      notify({
        type: "completed",
        runs: [completion("agent-1", "reader", { outcome: "failed", error })],
      });
      expect(content()).toContain(error);
      expect(content()).not.toMatch(/Error: \w*Error:/u);
    }
  });

  it("names a lone run in display-only details without changing delivered content", () => {
    const { sendMessage, notify } = notifier();
    notify({ type: "completed", runs: [completion("agent-1", "reader", { finalText: "ok" })] });
    notify({
      type: "question",
      id: "agent-2",
      name: "writer",
      requestId: "q-1",
      message: "May I?",
      generation: 1,
    });
    const [completed, question] = sendMessage.mock.calls.map(([message]) => message);
    expect(completed.details.name).toBe("reader");
    expect(question.details.name).toBe("writer");
    notify({
      type: "completed",
      runs: [completion("agent-3", "a"), completion("agent-4", "b")],
    });
    expect(sendMessage.mock.calls[2]?.[0].details.name).toBeUndefined();
  });

  it("directs failed profiled runs through remaining candidates before generalist", () => {
    const { notify, content } = notifier();

    notify({
      type: "completed",
      runs: [
        completion("agent-7", "reviewer", {
          outcome: "failed",
          error: "Claude usage exhausted.",
          profile: "reviewer",
          retryAvailable: true,
          remainingCandidateCount: 2,
        }),
      ],
    });

    expect(content()).toContain("2 configured reviewer candidates remain");
    expect(content()).toContain('subagent_lifecycle({ action: "retry", runIds: ["agent-7"] })');
    expect(content()).toContain("before launching any generalist replacement");
  });

  it("names the exact reply tool when a subagent asks a parent question", () => {
    const { sendMessage, notify, content } = notifier();

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
    expect(content()).toContain('subagent_reply({ runId: "agent-7", message: "..." })');
    expect(content()).toContain("then call subagent_await again");
    expect(content()).not.toContain("subagent({ action:");
    expect(sendMessage.mock.calls[0]?.[1]).toEqual(steer);
  });

  it("names the workflow and never asks the root to await a workflow agent's run", () => {
    const { notify, content } = notifier();
    const delivery = notify({
      type: "question",
      id: "agent-r1-4",
      name: "find-issues",
      requestId: "question-1",
      message: "Which module?",
      generation: 1,
      workflow: { workflowId: "wf-r1-1", name: "review", phase: "Find" },
    });
    expect(delivery?.actionAccepted).toBe(true);
    expect(content()).toContain("wf-r1-1");
    expect(content()).toContain('subagent_reply({ runId: "agent-r1-4", message: "..." })');
    // Root await rejects owned runs; the workflow resumes on its own after the reply.
    expect(content()).not.toContain("subagent_await");
  });

  it("explains a single completion without a final report", () => {
    const { notify, content } = notifier();

    notify({ type: "completed", runs: [completion("agent-1", "reader")] });

    expect(content()).toContain("Completed without a final report.");
  });

  it("coalesces completed and failed outcomes into one batch", () => {
    const { sendMessage, notify, content } = notifier();
    notify({
      type: "completed",
      runs: [
        completion("agent-1", "reader", { finalText: "Read." }),
        completion("agent-2", "reviewer", { generation: 2, finalText: "Reviewed." }),
        completion("agent-3", "tester", { outcome: "failed", error: "Tests failed." }),
      ],
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(content()).toContain("3 background subagents finished · 2 completed · 1 failed");
    for (const section of ["## reader (agent-1)", "## reviewer (agent-2)", "## tester (agent-3)"]) {
      expect(content()).toContain(section);
    }
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
    expect(content(1)).toContain("(continued 2)");
    expect(content(1)).toContain(
      "[Report truncated; use subagent_status or subagent_await for agent-2.]",
    );
    expect(delivery?.deliveredCompletionKeys).toEqual(["agent-1:1", "agent-2:1"]);
  });

  it("acknowledges only the first chunk when the second send accepts then throws", () => {
    let sendOrdinal = 0;
    const { sendMessage, notify } = notifier(
      vi.fn((): void => {
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
