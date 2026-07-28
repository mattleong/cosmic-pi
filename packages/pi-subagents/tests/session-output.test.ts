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
import { renderSubagentSessionOutput } from "../src/ui/session-output.ts";
import { sanitizeTerminalText } from "../src/ui/sanitize.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const runView = (overrides: Partial<SubagentRunView> = {}): SubagentRunView => ({
  id: "agent-1",
  name: "preview-check",
  task: "Inspect **preview rendering**.",
  selection: {
    source: "explicit",
    reason: "Explicit model selection.",
    skippedCandidates: [],
  },
  cwd: "/project",
  state: "completed",
  execution: "background",
  context: "fresh",
  writeIntent: "read-only",
  backend: "pi",
  capabilities: [
    "steer",
    "interrupt",
    "resume",
    "rename-display",
    "parent-contact",
    "peer-notice",
    "native-fork",
  ],
  model: "openai-codex/gpt-5.6-sol",
  effort: "high",
  startedAt: 1_000,
  endedAt: 4_000,
  lastActivityAt: 4_000,
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
    expect(summarizeToolArguments("Glob", { pattern: "**/*.test.ts", path: "src" })).toBe(
      "**/*.test.ts · src",
    );
  });

  it("clips oversized tool identifiers without erasing prior activity", () => {
    const prior = appendNoticeSessionEvent([], "parent", "Keep this", 1);
    const events = startToolSessionEvent(prior, {
      toolCallId: "x".repeat(256 * 1024),
      toolName: "read",
      args: { path: "README.md" },
      startedAt: 2,
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "notice", text: "Keep this" });
    expect(events[1]?.type === "tool" ? events[1].toolCallId.length : 0).toBeLessThanOrEqual(1_024);
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

    expect(rendered).toContain("preview-check  ✓ finished just now");
    expect(rendered).toContain("read-only · fresh · openai-codex/gpt-5.6-sol:high · 3s");
    expect(rendered).toContain("Task");
    expect(rendered).toContain("Inspect preview rendering.");
    expect(rendered).toContain("Activity");
    expect(rendered).toContain("✓ read  AGENTS.md");
    expect(rendered).toContain("Final report");
    expect(rendered).not.toContain("sent to parent");
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
        runView({
          sessionEvents: repeatedReads,
          pid: 42,
          sessionFile: "/tmp/session.jsonl",
          profile: "reviewer",
          selection: {
            source: "profile-candidate",
            candidateIndex: 1,
            reason: "Profile reviewer selected configured candidate 2.",
            skippedCandidates: [
              {
                candidateIndex: 0,
                candidate: "pi/old-model",
                code: "model_discouraged",
                reason: "Old model is discouraged.",
              },
            ],
            warning: "Explicit warning.",
          },
        }),
        theme,
        { now: 22_000, showTechnicalDetails: true },
      )
        .render(100)
        .join("\n"),
    );

    expect(rendered).toContain("✓ finished 18s ago");
    expect(rendered).toContain("read ×2");
    expect(rendered).toContain("src/one.ts · src/two.ts");
    expect(rendered).toContain("300ms");
    expect(rendered).toContain("Technical details");
    expect(rendered).toContain("agent-1 · profile reviewer · pi · background · pid 42");
    expect(rendered).toContain("selection  profile-candidate candidate 2");
    expect(rendered).toContain("skipped  pi/old-model [model_discouraged]");
    expect(rendered).toContain("policy  Explicit warning.");
    expect(rendered).toContain("session  /tmp/session.jsonl");
  });

  it("removes OSC terminal controls from Markdown task and report text", () => {
    const rendered = renderSubagentSessionOutput(
      runView({
        task: "Inspect\u001b]52;c;dGFzaw==\u0007 safely.",
        finalText: "Report\u001b]2;forged-title\u0007 complete.",
      }),
      theme,
    )
      .render(80)
      .join("\n");

    expect(rendered).toContain("Inspect safely.");
    expect(rendered).toContain("Report complete.");
    expect(rendered).not.toContain("dGFzaw==");
    expect(rendered).not.toContain("forged-title");
    expect(rendered).not.toContain("\u001b");
  });

  it("sanitizes CSI and OSC controls from model and every dynamic session header field", () => {
    const rendered = renderSubagentSessionOutput(
      runView({
        name: "review\u001b]2;forged-title\u0007-agent",
        model: "provider/evil\u001b[2Jmodel",
        error: "failure\u001b]52;c;Zm9yZ2Vk\u0007-safe",
        sessionEvents: [
          {
            type: "tool",
            toolCallId: "tool-malicious",
            toolName: "read\u001b[31m-forged",
            state: "failed",
            startedAt: 1,
            endedAt: 2,
          },
        ],
      }),
      theme,
    )
      .render(120)
      .join("\n");

    expect(rendered).toContain("review-agent");
    expect(rendered).toContain("provider/evilmodel:high");
    expect(rendered).toContain("read-forged");
    expect(rendered).toContain("failure-safe");
    expect(rendered).not.toContain("forged-title");
    expect(rendered).not.toContain("Zm9yZ2Vk");
    expect(rendered).not.toContain("\u001b[2J");
    expect(rendered).not.toContain("\u001b]");
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
        cwd: `/project/${"deep-cwd/".repeat(20)}`,
        sessionId: `session-${"identifier".repeat(20)}`,
        sessionFile: `/tmp/${"deep-session-path/".repeat(20)}session.jsonl`,
      }),
      theme,
      { showTechnicalDetails: true },
    );

    const width = 60;
    const rows = component.render(width);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.join("\n")).toContain("Technical details");
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
  });

  it("wraps long progress, warning, question, and error rows", () => {
    const width = 44;
    const long = "diagnostic detail ".repeat(30);
    const rows = renderSubagentSessionOutput(
      runView({
        state: "failed",
        endedAt: 5_000,
        progress: long,
        warning: long,
        question: { requestId: "q-1", message: long, createdAt: 4_000 },
        error: long,
      }),
      theme,
      { now: 6_000 },
    ).render(width);
    expect(rows.join("\n")).toContain("diagnostic detail");
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
  });
});
