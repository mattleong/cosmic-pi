import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import type { SubagentRunView } from "../../src/run/model.ts";
import { renderSubagentSessionOutput } from "../../src/ui/session-output.ts";
import { runStateGlyph, runStateLabel } from "../../src/ui/run-state.ts";

// SAFETY: The session output projection consumes fg/bold directly; markdown uses the global theme.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const baseRun = (overrides: Partial<SubagentRunView> = {}): SubagentRunView => ({
  id: "agent-1",
  name: "auth-review",
  task: "Review auth flows.",
  selection: {
    source: "profile-candidate",
    reason: "Selected in configured order.",
    skippedCandidates: [],
  },
  cwd: "/repo",
  state: "running",
  context: "fresh",
  writeIntent: "read-only",
  openaiFastMode: false,
  host: "local",
  runtime: "pi",
  closeOnReport: true,
  reportGeneration: 1,
  capabilities: ["resume", "interrupt"],
  model: "provider/model",
  effort: "high",
  startedAt: 1_000,
  lastActivityAt: 61_000,
  sessionEvents: [],
  usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: 0.25 },
  ...overrides,
});

const render = (run: SubagentRunView, showTechnicalDetails = false): string => {
  const component = renderSubagentSessionOutput(run, theme, {
    now: 61_000,
    showTechnicalDetails,
  });
  return component.render(120).join("\n");
};

describe("subagent session output projection", () => {
  beforeAll(() => initTheme("dark", false));

  it("projects identity, state label, route subtitle, and empty-activity guidance", () => {
    const text = render(baseRun());
    expect(text).toContain("auth-review");
    expect(text).toContain(`${runStateGlyph("running")} ${runStateLabel("running")}`);
    expect(text).toContain("fresh · provider/model:high");
    expect(text).toContain("read-only");
    expect(text).toContain("Working…");
    expect(text).not.toContain("Technical details");
    expect(text).not.toContain("agent-1");
  });

  it("differentiates paused guidance by resume capability", () => {
    const resumable = render(baseRun({ state: "paused" }));
    expect(resumable).toContain("Paused; resume when ready.");
    const interrupted = render(baseRun({ state: "paused", capabilities: ["interrupt"] }));
    expect(interrupted).toContain(
      "Interrupted; stop this run and start a replacement when needed.",
    );
  });

  it("renders terminal, report, and failure conclusions once", () => {
    const reported = render(
      baseRun({
        state: "reported",
        endedAt: 60_000,
        finalText: "Report body text.",
        reportGeneration: 3,
      }),
    );
    expect(reported).toContain("Report generation 3 · backend retained");
    expect(reported).toContain("Report body text.");

    const silentCompletion = render(baseRun({ state: "completed", endedAt: 60_000 }));
    expect(silentCompletion).toContain("Completed without a final report.");

    const failure = render(
      baseRun({ state: "failed", endedAt: 60_000, error: "Backend crashed." }),
    );
    expect(failure).toContain("Error: Backend crashed.");
    expect(failure).not.toContain("Completed without a final report.");
  });

  it("renders live question, warning, and progress only when notices do not cover them", () => {
    const live = render(
      baseRun({
        question: { requestId: "q1", message: "Proceed?", createdAt: 2 },
        warning: "Route fell back.",
        progress: "Reading files",
      }),
    );
    expect(live).toContain("Proceed?");
    expect(live).toContain("Route fell back.");
    expect(live).toContain("Reading files");

    const covered = render(
      baseRun({
        question: { requestId: "q1", message: "Proceed?", createdAt: 2 },
        warning: "Route fell back.",
        sessionEvents: [
          { type: "notice", kind: "question", text: "Question: Proceed?", createdAt: 2 },
          { type: "notice", kind: "warning", text: "Warning: Route fell back.", createdAt: 3 },
        ],
      }),
    );
    expect(covered.match(/Proceed\?/g)).toHaveLength(1);
    expect(covered.match(/Route fell back\./g)).toHaveLength(1);
  });

  it("gates technical details behind the explicit option", () => {
    const technical = render(baseRun({ profile: "reviewer" }), true);
    expect(technical).toContain("Technical details");
    expect(technical).toContain("agent-1");
    expect(technical).toContain("profile reviewer");
    expect(technical).toContain("Selected in configured order.");
  });
});
