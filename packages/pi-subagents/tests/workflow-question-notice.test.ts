import { describe, expect, it, vi } from "vitest";
import { makeHostNotifier } from "../src/boundary/host-notifier.ts";
import { extensionApiFixture } from "./fixtures/pi-host.ts";

describe("workflow agent question notice", () => {
  it("names the workflow and never asks the root to await an owned run", () => {
    const sendMessage = vi.fn();
    const notify = makeHostNotifier(extensionApiFixture({ sendMessage }));

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
    const content = String(sendMessage.mock.calls[0]?.[0].content);
    expect(content).toContain("wf-r1-1");
    expect(content).toContain('subagent_reply({ runId: "agent-r1-4", message: "..." })');
    // Root await rejects owned runs; the workflow resumes on its own after the reply.
    expect(content).not.toContain("subagent_await");
  });
});
