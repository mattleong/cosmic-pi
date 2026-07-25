import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { SubagentRunView } from "../src/run/model.ts";
import {
  appendAssistantSessionEvent,
  appendNoticeSessionEvent,
  finishToolSessionEvent,
  startToolSessionEvent,
  summarizeToolArguments,
} from "../src/run/session-output.ts";
import { renderSubagentSessionOutput } from "../src/tools/renderers/session-output.ts";
import { sanitizeTerminalText } from "../src/ui/sanitize.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const runView = (overrides: Partial<SubagentRunView> = {}): SubagentRunView => ({
  id: "agent-1",
  name: "preview-check",
  task: "Inspect **preview rendering**.",
  cwd: "/project",
  state: "completed",
  execution: "background",
  context: "fresh",
  writeIntent: "read-only",
  model: "openai-codex/gpt-5.6-sol",
  effort: "high",
  startedAt: 1_000,
  endedAt: 4_000,
  lastActivityAt: 4_000,
  transcript: [],
  sessionEvents: [],
  finalText: "## Findings\n\n- Preview rendering works.",
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 0.01 },
  ...overrides,
});

describe("structured subagent session output", () => {
  beforeAll(() => initTheme("dark", false));

  it("tracks bounded tool and assistant events with sanitized targets", () => {
    let events = startToolSessionEvent([], {
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "src/auth.ts", token: "secret-value" },
      startedAt: 1,
    });
    events = finishToolSessionEvent(events, {
      toolCallId: "tool-1",
      toolName: "read",
      isError: false,
      endedAt: 2,
    });
    events = appendNoticeSessionEvent(events, "parent", "Focus on token=secret-value", 3);
    events = appendAssistantSessionEvent(events, "## Findings\n\nDone.", 4);

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      type: "tool",
      toolName: "read",
      target: "src/auth.ts",
      state: "completed",
    });
    expect(events[1]).toMatchObject({ type: "notice", text: "Focus on token=[REDACTED]" });
    expect(events[2]).toMatchObject({ type: "assistant", text: "## Findings\n\nDone." });
    expect(summarizeToolArguments("bash", { command: "echo token=secret-value" })).toBe(
      "echo token=[REDACTED]",
    );
  });

  it("renders task, grouped activity, a final report, and compact metadata", () => {
    const sessionEvents = appendAssistantSessionEvent(
      finishToolSessionEvent(
        startToolSessionEvent([], {
          toolCallId: "tool-1",
          toolName: "read",
          args: { path: "AGENTS.md" },
          startedAt: 1_500,
        }),
        { toolCallId: "tool-1", toolName: "read", isError: false, endedAt: 2_000 },
      ),
      "## Findings\n\n- Rule confirmed.",
      3_000,
    );
    const component = renderSubagentSessionOutput(runView({ sessionEvents }), theme);
    const rendered = sanitizeTerminalText(component.render(100).join("\n"));

    expect(rendered).toContain("preview-check  ✓ completed");
    expect(rendered).toContain("read-only · fresh · openai-codex/gpt-5.6-sol:high · 3s");
    expect(rendered).toContain("Task");
    expect(rendered).toContain("Inspect preview rendering.");
    expect(rendered).toContain("Activity");
    expect(rendered).toContain("✓ read  AGENTS.md");
    expect(rendered).toContain("Final report  sent to parent");
    expect(rendered).toContain("Preview rendering works.");
    expect(rendered).not.toContain("Rule confirmed.");
    expect(rendered).not.toContain("agent-1");
    expect(rendered).toContain("15 tokens · $0.0100");
  });

  it("groups adjacent repeated tools and reveals technical details on request", () => {
    const repeatedReads: SubagentRunView["sessionEvents"] = [
      {
        type: "tool",
        toolCallId: "tool-1",
        toolName: "read",
        target: "src/one.ts",
        state: "completed",
        startedAt: 1_000,
        endedAt: 1_100,
      },
      {
        type: "tool",
        toolCallId: "tool-2",
        toolName: "read",
        target: "src/two.ts",
        state: "completed",
        startedAt: 1_200,
        endedAt: 1_400,
      },
    ];
    const rendered = sanitizeTerminalText(
      renderSubagentSessionOutput(
        runView({ sessionEvents: repeatedReads, pid: 42, sessionFile: "/tmp/session.jsonl" }),
        theme,
        { now: 22_000, showTechnicalDetails: true },
      )
        .render(100)
        .join("\n"),
    );

    expect(rendered).toContain("✓ completed 18s ago");
    expect(rendered).toContain("read ×2");
    expect(rendered).toContain("src/one.ts · src/two.ts");
    expect(rendered).toContain("300ms");
    expect(rendered).toContain("Technical details");
    expect(rendered).toContain("agent-1 · background · pid 42");
    expect(rendered).toContain("session  /tmp/session.jsonl");
  });

  it("does not label stale assistant text as a final report while active", () => {
    const rendered = sanitizeTerminalText(
      renderSubagentSessionOutput(
        runView({ state: "running", endedAt: undefined, finalText: "Old report." }),
        theme,
        { now: 5_000 },
      )
        .render(80)
        .join("\n"),
    );
    expect(rendered).not.toContain("Final report");
    expect(rendered).not.toContain("Old report.");
  });

  it.each([
    ["starting", "Starting…"],
    ["running", "Working…"],
    ["waiting_for_parent", "Waiting for parent…"],
    ["paused", "Paused."],
  ] as const)("renders state-specific empty activity for %s", (state, label) => {
    const rendered = sanitizeTerminalText(
      renderSubagentSessionOutput(
        runView({ state, endedAt: undefined, finalText: undefined }),
        theme,
        { now: 4_000 },
      )
        .render(80)
        .join("\n"),
    );
    expect(rendered).toContain(label);
    expect(rendered).not.toContain("No child activity yet");
  });

  it("wraps every expanded row within the available viewport width", () => {
    const component = renderSubagentSessionOutput(
      runView({
        task: `Inspect ${"nested/path/".repeat(20)}file.ts`,
        finalText: `## Findings\n\n${"A long viewport-safe report sentence. ".repeat(20)}`,
        sessionFile: `/tmp/${"deep-session-path/".repeat(20)}session.jsonl`,
      }),
      theme,
    );

    const width = 60;
    const rows = component.render(width);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
  });
});
