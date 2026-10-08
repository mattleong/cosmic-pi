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
    expect(text).toContain("provider/model");
    expect(text).toContain("read-only");
    // Idle guidance uses the state word every extension uses.
    expect(text.toLowerCase()).toContain(`${managerActivityLabel("running")}…`);
    expect(text).not.toContain("agent-1");
  });

  it("differentiates paused guidance by resume capability", () => {
    const resumable = render(baseRun({ state: "paused" }));
    expect(render(baseRun({ state: "paused", capabilities: ["interrupt"] }))).not.toBe(resumable);
  });

  it("renders terminal, report, and failure conclusions once", () => {
    const reported = render(
      baseRun({ state: "completed", endedAt: 60_000, finalText: "Report body text." }),
    );
    expect(reported.match(/Report body text\./g)).toHaveLength(1);

    // A completed run without a report says why, distinctly for each report status.
    const statuses = [undefined, "claimed", "delivered", "missing"] as const;
    const silent = statuses.map((reportStatus) =>
      render(baseRun({ state: "completed", endedAt: 60_000, reportStatus })),
    );
    expect(new Set(silent).size).toBe(statuses.length);

    const failure = render(
      baseRun({ state: "failed", endedAt: 60_000, error: "Backend crashed." }),
    );
    expect(failure.match(/Backend crashed\./g)).toHaveLength(1);
  });

  it("renders live question, warning, and progress only when notices do not cover them", () => {
    const live = render(
      baseRun({
        question: { requestId: "q1", message: "Proceed?" },
        warning: "Route fell back.",
        progress: "Reading files",
      }),
    );
    expect(live).toContain("Proceed?");
    expect(live).toContain("Route fell back.");
    expect(live).toContain("Reading files");

    const covered = render(
      baseRun({
        question: { requestId: "q1", message: "Proceed?" },
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
    const technical = render(baseRun(), true);
    expect(technical).toContain("agent-1");
    expect(technical).toContain("Selected in configured order.");
  });
});
