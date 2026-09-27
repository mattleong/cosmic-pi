import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import { plainTheme } from "pi-cosmic-core/testing";
import { managerActivityLabel } from "pi-cosmic-ui/manager";
import type { SubagentRunView } from "../../src/run/model.ts";
import { renderSubagentSessionOutput } from "../../src/ui/session-output.ts";
import { runStateGlyph, runStateLabel } from "../../src/ui/run-state.ts";
import { view } from "../fixtures/run-view.ts";

const baseRun = (overrides: Partial<SubagentRunView> = {}): SubagentRunView =>
  view({
    model: "provider/model",
    selection: { ...view().selection, reason: "Selected in configured order." },
    ...overrides,
  });

const render = (run: SubagentRunView, showTechnicalDetails = false): string => {
  const component = renderSubagentSessionOutput(run, plainTheme, {
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
    // Idle guidance uses the state word every extension uses.
    expect(text.toLowerCase()).toContain(`${managerActivityLabel("running")}…`);
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
    expect(silentCompletion).toContain("availability unknown");
    expect(silentCompletion).not.toContain("No accepted final report");
    expect(render(baseRun({ state: "completed", reportStatus: "claimed" }))).toContain(
      "claimed by another operation",
    );
    expect(render(baseRun({ state: "completed", reportStatus: "delivered" }))).toContain(
      "already delivered",
    );
    expect(render(baseRun({ state: "completed", reportStatus: "missing" }))).toContain(
      "No accepted final report",
    );

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
