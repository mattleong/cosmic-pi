import { applyPresentationSettings, captureRegistrations } from "pi-code-previews/testing";
import { formatCost, formatTokens } from "pi-cosmic-core";
import { plainTheme } from "pi-cosmic-core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSubagentMessageRenderers } from "../../src/application/messages.ts";
import { makeHostNotifier } from "../../src/boundary/host-notifier.ts";
import {
  emptyWorkflowUsage,
  WORKFLOW_LOG_LIMIT,
  type WorkflowRunView,
  type WorkflowSource,
} from "../../src/workflow/model.ts";
import {
  fitWorkflowResult,
  interruptedWorkflowNotification,
  workflowNotification,
  workflowResultBudget,
} from "../../src/workflow/notification.ts";
import { clipWorkflowText } from "../../src/workflow/run-text.ts";
import { withWorkflowEvent } from "../../src/workflow/state.ts";
import { extensionApiFixture } from "../fixtures/pi-host.ts";
import { workflowRunView } from "../fixtures/run-view.ts";

/** A run started from an inline script whose copy was never saved, so it has no file to restart. */
const inlineOrigin = { source: { kind: "inline" } } as const;

const finishedRun = (patch: Partial<WorkflowRunView> = {}): WorkflowRunView =>
  workflowRunView({
    id: "wf-a-7",
    phases: [{ title: "Find" }],
    state: "completed",
    startedAt: 1_000,
    endedAt: 61_000,
    agents: [
      { callId: 1, runId: "agent-1", label: "finder", state: "completed", queuedAt: 1_000 },
      {
        callId: 2,
        runId: "agent-2",
        label: "fixer",
        state: "completed",
        queuedAt: 1_000,
        workspaceId: "workspace-3",
      },
      { callId: 3, runId: "agent-3", label: "flaky", state: "failed", queuedAt: 1_000 },
    ],
    reused: 2,
    logs: [{ at: 2_000, level: "warning", message: "agent flaky failed: timeout" }],
    usage: { ...emptyWorkflowUsage(), output: 10, totalTokens: 40 },
    result: { text: '{ "bugs": 2 }', clipped: false },
    ...patch,
  });

let restore = () => {};
afterEach(() => restore());

describe("workflow notification", () => {
  it("carries the result, agent counts and worktree proposals for the main agent", () => {
    const notification = workflowNotification(finishedRun())!;
    expect(notification).toMatchObject({
      type: "workflow",
      runId: "wf-a-7",
      outcome: "completed",
      durationMs: 60_000,
      agents: { total: 5, failed: 1, stopped: 0, skipped: 0, reused: 2 },
      workspaces: ["workspace-3"],
    });
    expect(notification.content).toContain('{ "bugs": 2 }');
    expect(notification.content).toContain("workspace-3");
    expect(notification.content).toContain("subagent_workspace");
  });

  it("counts stopped agents apart from skipped ones, and calls that never started", () => {
    const ended = { queuedAt: 1_000, endedAt: 3_000 };
    const notification = workflowNotification(
      finishedRun({
        state: "stopped",
        stoppedBy: "user",
        result: undefined,
        reused: 0,
        agents: [
          { ...ended, callId: 1, runId: "a-1", label: "a", state: "completed", startedAt: 1_000 },
          { ...ended, callId: 2, runId: "a-2", label: "b", state: "stopped", startedAt: 1_000 },
          { ...ended, callId: 3, runId: "a-3", label: "c", state: "stopped" },
          { ...ended, callId: 4, runId: "a-4", label: "d", state: "skipped" },
        ],
      }),
    )!;
    expect(notification.agents).toMatchObject({ total: 4, stopped: 2, skipped: 1 });
    const agentsLine = notification.content.split("\n").find((line) => line.startsWith("Agents:"));
    expect(agentsLine).toMatch(/\b2 started\b/u);
    expect(agentsLine).toMatch(/\b2 stopped\b/u);
    expect(agentsLine).toMatch(/\b1 skipped\b/u);
    expect(agentsLine).toMatch(/\b2 agent\(\) calls never started\b/u);
  });

  it("names the run to resume and the error when the script failed", () => {
    const notification = workflowNotification(
      finishedRun({
        state: "failed",
        result: undefined,
        failure: { name: "TypeError", message: "bad input", stack: "at line 3" },
      }),
    )!;
    expect(notification.outcome).toBe("failed");
    expect(notification.content).toContain("bad input");
    expect(notification.content).toContain("at line 3");
    expect(notification.content).toContain('resumeFromRunId: "wf-a-7"');
    expect(notification.content).toContain("agent flaky failed: timeout");
  });

  it("keeps the location of a clipped result ahead of its text", () => {
    const text = `HEAD${"x".repeat(60_000)}TAIL`;
    const clipped = clipWorkflowText(text);
    expect(clipped.length).toBeLessThanOrEqual(28 * 1024);
    expect(clipped.startsWith("HEAD")).toBe(true);
    expect(clipped.endsWith("TAIL")).toBe(true);
    const notification = workflowNotification(
      finishedRun({ result: { text: clipped, clipped: true, path: "/tmp/full-result.json" } }),
    )!;
    expect(notification.content.indexOf("/tmp/full-result.json")).toBeLessThan(
      notification.content.indexOf("HEAD"),
    );
    expect(notification.content.length).toBeLessThan(32 * 1024);
  });

  it("repeats warnings that explain null results when the run completed", () => {
    const notification = workflowNotification(finishedRun())!;
    expect(notification.content).toContain("agent flaky failed: timeout");
  });

  it("keeps reporting warnings after later log lines evicted them from the log", () => {
    const warned = withWorkflowEvent(
      finishedRun({ logs: [] }),
      { type: "log", level: "warning", message: "parallel() item 0 failed: bad profile" },
      2_000,
    );
    const run = Array.from({ length: WORKFLOW_LOG_LIMIT + 10 }, (_, index) => index).reduce(
      (current, index) =>
        withWorkflowEvent(current, { type: "log", message: `progress ${index}` }, 3_000 + index),
      warned,
    );
    expect(run.logs.some((entry) => entry.level === "warning")).toBe(false);
    expect(workflowNotification(run)!.content).toContain("bad profile");
  });

  it("fits a result whose redaction would push the notification past the host's clip", () => {
    // Each short secret-like value grows when the host redacts it.
    const text = `${Array.from({ length: 1_300 }, (_, index) => `item ${index} token=1`).join("\n")}\nEND`;
    const run = finishedRun({ result: undefined });
    expect(text.length).toBeLessThan(workflowResultBudget(run));
    const fitted = fitWorkflowResult(run, text);
    expect(fitted.clipped).toBe(true);
    const notification = workflowNotification({
      ...run,
      result: { ...fitted, path: "/tmp/full-result.txt" },
    })!;
    const sendMessage = vi.fn();
    makeHostNotifier(extensionApiFixture({ sendMessage }))(notification);
    // The host delivers the content whole, so the saved file's path and the tail survive.
    expect(sendMessage.mock.calls[0]![0].content).toBe(notification.content);
    expect(notification.content).toContain("/tmp/full-result.txt");
    expect(notification.content.endsWith("END")).toBe(true);
  });

  it("keeps as much of a result as fits when redaction more than doubles it", () => {
    // `token=1` redacts to more than twice its length, so the clip window must shrink by more
    // than half, yet a large share of the room is still left for the result.
    const text = `${Array.from({ length: 6_000 }, (_, index) => `token=${index % 10}`).join("\n")}\nEND`;
    const run = finishedRun({ result: undefined });
    const fitted = fitWorkflowResult(run, text);
    expect(fitted.clipped).toBe(true);
    expect(fitted.text.length).toBeGreaterThan(10_000);
    const notification = workflowNotification({
      ...run,
      result: { ...fitted, path: "/tmp/full-result.txt" },
    })!;
    expect(notification.content.length).toBeLessThanOrEqual(32 * 1024);
    expect(notification.content.endsWith("END")).toBe(true);
  });

  it("keeps a failed run's notification within its bound however long its error is", () => {
    // Every short secret-like value grows when redacted, so bounds apply to redacted text.
    const dense = "token=1 ".repeat(20_000);
    const notification = workflowNotification(
      finishedRun({
        state: "failed",
        result: undefined,
        failure: { message: dense, stack: dense },
        logs: Array.from({ length: 12 }, (_, index) => ({
          at: index,
          level: "info" as const,
          message: dense.slice(0, 2_000),
        })),
      }),
    )!;
    expect(notification.content.length).toBeLessThanOrEqual(30 * 1024);
    expect(notification.content).toContain('resumeFromRunId: "wf-a-7"');
  });

  it("lists a bounded number of worktrees and leaves the result the rest of the room", () => {
    const writers = Array.from({ length: 60 }, (_, index) => ({
      callId: index + 1,
      runId: `agent-${index + 1}`,
      label: `migrate-${index + 1}`,
      state: "completed" as const,
      queuedAt: 1_000,
      workspaceId: `workspace-${index + 1}`,
    }));
    const crowded = finishedRun({ agents: writers });
    const notification = workflowNotification(crowded)!;
    expect(notification.workspaces).toHaveLength(60);
    expect(notification.content).toContain("workspace-40 ");
    expect(notification.content).not.toContain("workspace-41 ");
    expect(notification.content).toContain("20 more");
    expect(workflowResultBudget(crowded)).toBeLessThan(workflowResultBudget(finishedRun()));
    const result = "r".repeat(workflowResultBudget(crowded));
    const fitted = workflowNotification({ ...crowded, result: { text: result, clipped: false } })!;
    expect(fitted.content.length).toBeLessThanOrEqual(32 * 1024);
  });

  it("counts writers whose worktrees held no changes instead of listing them", () => {
    const writers = Array.from({ length: 60 }, (_, index) => ({
      callId: index + 1,
      runId: `agent-${index + 1}`,
      label: `migrate-${index + 1}`,
      state: "completed" as const,
      queuedAt: 1_000,
      workspaceId: `workspace-${index + 1}`,
      ...(index % 20 !== 0 && { unchanged: true as const }),
    }));
    const notification = workflowNotification(finishedRun({ agents: writers }))!;
    expect(notification.workspaces).toEqual(["workspace-1", "workspace-21", "workspace-41"]);
    expect(notification.content).toContain("workspace-21 ");
    expect(notification.content).not.toContain("workspace-2 ");
    expect(notification.content).toMatch(/\b57\b/u);
    const reader = finishedRun().agents[0]!;
    const allUnchanged = workflowNotification(
      finishedRun({
        agents: [reader, ...writers.map((writer) => ({ ...writer, unchanged: true as const }))],
      }),
    )!;
    expect(allUnchanged.workspaces).toEqual([]);
    expect(allUnchanged.content).toMatch(/\b60\b/u);
  });

  it("sends nothing for a run the main agent stopped itself", () => {
    expect(workflowNotification(finishedRun({ state: "stopped", stoppedBy: "tool" }))).toBe(
      undefined,
    );
    const byUser = workflowNotification(finishedRun({ state: "stopped", stoppedBy: "user" }))!;
    expect(byUser.outcome).toBe("stopped");
    expect(byUser.content).not.toContain("resumeFromRunId");
  });

  it("names the results journal, the run's usage and planned agents that never ran", () => {
    const journalPath = "/agent/subagents/workflow-runs/wf-a-7/journal.jsonl";
    const usage = {
      ...emptyWorkflowUsage(),
      input: 1_100_000,
      output: 61_000,
      totalTokens: 1_240_000,
      cost: 4.1,
      toolUses: 388,
    };
    const notification = workflowNotification(
      finishedRun({
        usage,
        journalPath,
        planned: [{ runId: "agent-9", phase: "Find", label: "unused" }],
      }),
    )!;
    expect(notification.usage).toEqual({ totalTokens: 1_240_000, cost: 4.1 });
    expect(notification.content).toContain(journalPath);
    for (const fact of [formatTokens(1_240_000), formatTokens(61_000), formatCost(4.1), "388"])
      expect(notification.content).toContain(fact);
    expect(notification.content).not.toContain("agent-9");
    const without = workflowNotification(finishedRun())!;
    expect(without.content).not.toContain("journal.jsonl");
  });

  it("tells the main agent how to extend a completed run from the workflow's own file", () => {
    const saved = workflowNotification(
      finishedRun({
        source: { kind: "saved", name: "review", scope: "project", path: "/repo/review.js" },
        scriptPath: "/agent/subagents/workflow-runs/wf-a-7/script.js",
      }),
    )!.content;
    expect(saved).toContain("/repo/review.js");
    expect(saved).toContain('name: "review"');
    expect(saved).toContain('resumeFromRunId: "wf-a-7"');
    expect(saved).not.toContain("workflow-runs/wf-a-7/script.js");
    const copy = "/agent/subagents/workflow-runs/wf-a-7/script.js";
    const inline = workflowNotification(finishedRun({ scriptPath: copy }))!.content;
    expect(inline).toContain(`scriptPath: "${copy}"`);
    expect(inline).toContain('resumeFromRunId: "wf-a-7"');
  });

  it("points a failed run's fix at its saved script", () => {
    const scriptPath = "/agent/subagents/workflow-runs/wf-a-7/script.js";
    const notification = workflowNotification(
      finishedRun({
        state: "failed",
        result: undefined,
        scriptPath,
        failure: { name: "TypeError", message: "bad input" },
      }),
    )!;
    expect(notification.content).toContain(scriptPath);
    expect(notification.content).toContain('resumeFromRunId: "wf-a-7"');
  });

  it("points a failed script file's fix at that file, not the run's copy", () => {
    const copy = "/agent/subagents/workflow-runs/wf-a-7/script.js";
    const notification = workflowNotification(
      finishedRun({
        state: "failed",
        result: undefined,
        source: { kind: "file", path: "/project/scripts/review.js" },
        scriptPath: copy,
        failure: { name: "TypeError", message: "bad input" },
      }),
    )!;
    expect(notification.content).toContain('scriptPath: "/project/scripts/review.js"');
    expect(notification.content).toContain('resumeFromRunId: "wf-a-7"');
    expect(notification.content).not.toContain(copy);
  });

  it("restarts an interrupted inline run from its saved copy, and a file run from its file", () => {
    const copy = "/runs/wf-a-3/script.js";
    const interrupted = (source: WorkflowSource) =>
      interruptedWorkflowNotification({
        runId: "wf-a-3",
        name: "migration",
        finished: 1,
        workspaces: [],
        origin: { source, scriptPath: copy },
      }).content;
    const inline = interrupted({ kind: "inline" });
    expect(inline).toContain(`scriptPath: "${copy}"`);
    expect(inline).toContain('resumeFromRunId: "wf-a-3"');
    const file = interrupted({ kind: "file", path: "/project/migrate.js" });
    expect(file).toContain('scriptPath: "/project/migrate.js"');
    expect(file).toContain('resumeFromRunId: "wf-a-3"');
    expect(file).not.toContain(copy);
  });

  it("names an interrupted run, how to resume it and its worktrees", () => {
    const notice = interruptedWorkflowNotification({
      runId: "wf-a-3",
      name: "migration",
      finished: 4,
      workspaces: ["workspace-1"],
      origin: inlineOrigin,
    });
    expect(notice).toMatchObject({ outcome: "interrupted", workspaces: ["workspace-1"] });
    expect(notice.content).toContain('resumeFromRunId: "wf-a-3"');
    expect(notice.content).toContain("workspace-1");
  });

  it("offers no restart for a run that was being stopped when the session was torn down", () => {
    const notice = interruptedWorkflowNotification({
      runId: "wf-a-3",
      name: "migration",
      finished: 4,
      workspaces: ["workspace-1"],
      stopped: true,
      origin: inlineOrigin,
    });
    expect(notice.content).not.toContain("resumeFromRunId");
    expect(notice.workspaces).toEqual(["workspace-1"]);
    expect(notice.content).toContain("workspace-1");
  });

  it("is absent while the run is still going", () => {
    expect(workflowNotification(finishedRun({ state: "running", endedAt: undefined }))).toBe(
      undefined,
    );
  });

  it("records the run's tokens for its row, and a cost only when every agent reported one", () => {
    const sendMessage = vi.fn();
    const notify = makeHostNotifier(extensionApiFixture({ sendMessage }));
    const usage = { ...emptyWorkflowUsage(), totalTokens: 1_234, cost: 0.5 };
    notify(workflowNotification(finishedRun({ usage }))!);
    expect(sendMessage.mock.calls[0]![0].details).toMatchObject({ totalTokens: 1_234, cost: 0.5 });
    notify(workflowNotification(finishedRun({ usage: { ...usage, unpriced: 1 } }))!);
    expect(sendMessage.mock.calls[1]![0].details).toMatchObject({ totalTokens: 1_234 });
    expect(sendMessage.mock.calls[1]![0].details).not.toHaveProperty("cost");
  });

  it("steers the root once and reports a host that couldn't accept it", () => {
    const sendMessage = vi.fn();
    const notify = makeHostNotifier(extensionApiFixture({ sendMessage }));
    const notification = workflowNotification(finishedRun())!;
    expect(notify(notification)).toEqual({ actionAccepted: true });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "pi-subagents-workflow",
        display: true,
        content: notification.content,
      }),
      { deliverAs: "steer", triggerTurn: true },
    );
    const failing = makeHostNotifier(
      extensionApiFixture({
        sendMessage: vi.fn(() => {
          throw new Error("stale session");
        }),
      }),
    );
    expect(failing(notification)).toEqual({ actionAccepted: false });
  });

  it("informs the next turn without starting one for a user's stop or an interrupted run", () => {
    const sendMessage = vi.fn();
    const notify = makeHostNotifier(extensionApiFixture({ sendMessage }));
    notify(workflowNotification(finishedRun({ state: "stopped", stoppedBy: "user" }))!);
    notify(
      interruptedWorkflowNotification({
        runId: "wf-a-3",
        name: "x",
        finished: 0,
        workspaces: [],
        origin: inlineOrigin,
      }),
    );
    expect(sendMessage.mock.calls.map((call) => call[1])).toEqual([
      { deliverAs: "steer", triggerTurn: false },
      { deliverAs: "steer", triggerTurn: false },
    ]);
  });

  it.each(["compact", "preview"] as const)(
    "renders one %s row naming the workflow and the full content when expanded",
    (style) => {
      restore = applyPresentationSettings({ toolCallCollapsedStyle: style });
      const renderers = captureRegistrations(registerSubagentMessageRenderers).messageRenderers;
      const sendMessage = vi.fn();
      makeHostNotifier(extensionApiFixture({ sendMessage }))(workflowNotification(finishedRun())!);
      const message = sendMessage.mock.calls[0]![0];
      const render = renderers.get("pi-subagents-workflow")!;
      const collapsed = render(
        { ...message, role: "custom", timestamp: 0 },
        { expanded: false, outputPad: 0 },
        plainTheme,
      )!
        .render(160)
        .join("\n");
      expect(collapsed).toContain("review");
      expect(collapsed).not.toContain("wf-a-7");
      const expanded = render(
        { ...message, role: "custom", timestamp: 0 },
        { expanded: true, outputPad: 0 },
        plainTheme,
      )!
        .render(160)
        .join("\n");
      expect(expanded).toContain("wf-a-7");
      expect(expanded).toContain('"bugs": 2');
    },
  );

  it("renders an interrupted run as a workflow row naming it", () => {
    restore = applyPresentationSettings({ toolCallCollapsedStyle: "compact" });
    const renderers = captureRegistrations(registerSubagentMessageRenderers).messageRenderers;
    const sendMessage = vi.fn();
    makeHostNotifier(extensionApiFixture({ sendMessage }))(
      interruptedWorkflowNotification({
        runId: "wf-a-3",
        name: "migration",
        finished: 2,
        workspaces: [],
        origin: inlineOrigin,
      }),
    );
    const message = sendMessage.mock.calls[0]![0];
    const collapsed = renderers.get("pi-subagents-workflow")!(
      { ...message, role: "custom", timestamp: 0 },
      { expanded: false, outputPad: 0 },
      plainTheme,
    )!
      .render(160)
      .join("\n");
    expect(collapsed).toContain("migration");
    expect(collapsed).not.toContain("wf-a-3");
  });
});
