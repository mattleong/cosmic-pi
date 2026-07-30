import { describe, expect, it } from "vitest";
import { formatHerdrManagerLabel } from "../src/settings/controller.ts";
import type { HerdrAgentView } from "../src/herd/model.ts";
import { herdrFooterStatus } from "../src/herd/projection.ts";
import {
  formatHerdrAgentDetails,
  formatHerdrAgentList,
  formatHerdrReports,
  formatHerdrTerminalRead,
  withHerdrFailures,
} from "../src/tools/format.ts";

const agent = (overrides: Partial<HerdrAgentView> = {}): HerdrAgentView => ({
  id: "herdr-11111111-1111-4111-8111-111111111111",
  kind: "claude",
  model: "sonnet",
  name: "Claude 1",
  agentName: "pih-1111111111111111",
  task: "Review the authentication flow.",
  cwd: "/repo",
  state: "working",
  remoteStatus: "working",
  session: "current",
  workspaceId: "w1",
  tabId: "w1:t1",
  paneId: "w1:p1",
  terminalId: "terminal-1",
  reportGeneration: "generation-1",
  startedAt: 0,
  updatedAt: 1_000,
  ...overrides,
});

describe("pi-herdr presentation", () => {
  it("keeps retained completion history out of the live footer", () => {
    expect(
      herdrFooterStatus({
        revision: 1,
        agents: [agent({ state: "completed", report: "done" })],
      }),
    ).toBeUndefined();
    expect(
      herdrFooterStatus({
        revision: 1,
        agents: [agent(), agent({ state: "blocked", id: "herdr-blocked" })],
      }),
    ).toBe("Herdr: 1 agent active · 1 blocked");
    expect(
      herdrFooterStatus({
        revision: 1,
        agents: [agent({ state: "blocked", report: "final blocker" })],
      }),
    ).toBeUndefined();
  });

  it("uses readable, unique manager labels for duplicate display names", () => {
    const first = agent({ state: "awaiting_report" });
    const second = agent({ id: "herdr-22222222-2222-4222-8222-222222222222" });
    expect(formatHerdrManagerLabel(first, 0)).toContain("1. [claude] Claude 1 · awaiting report");
    expect(formatHerdrManagerLabel(first, 0)).not.toBe(formatHerdrManagerLabel(second, 1));
  });

  it("summarizes and bounds historical list noise", () => {
    const agents = [
      agent(),
      agent({ id: "herdr-2", state: "completed", report: "done" }),
      agent({ id: "herdr-3", state: "stopped" }),
    ];
    const output = formatHerdrAgentList(agents, 2);
    expect(output).toContain("Herdr agents: 1 running · 0 blocked · 2 finished");
    expect(output).toContain("showing 1–2 of 3");
    expect(output).toContain("1 more run; call herdr_agent_list with offset=2.");
    expect(output).not.toContain("w1/w1:t1");
    expect(formatHerdrAgentList(agents, 2, 2)).toContain("showing 3–3 of 3");
  });

  it("makes status output materially more detailed than list output", () => {
    const output = formatHerdrAgentDetails(
      agent({ state: "failed", error: "Claude settled without a report." }),
    );
    expect(output).toContain("Herdr agent status");
    expect(output).toContain("Task");
    expect(output).toContain("Attention");
    expect(output).toContain("w1/w1:t1/w1:p1");
  });

  it("preserves every report header and marks per-report truncation", () => {
    const output = formatHerdrReports([
      agent({ name: "First", report: `\u001b[31m${"a".repeat(40_000)}` }),
      agent({
        id: "herdr-22222222-2222-4222-8222-222222222222",
        name: "Second",
        report: "b".repeat(40_000),
      }),
    ]);
    expect(output).toContain("## First [claude] (working)");
    expect(output).toContain("## Second [claude] (working)");
    expect(output.match(/report truncated/g)).toHaveLength(2);
    expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(51_200);
    expect(output).not.toContain("\u001b[31m");
  });

  it("explains how to recover from blocked reports and failed batches", () => {
    expect(
      formatHerdrReports([
        agent({ state: "blocked", report: `Need a decision. ${"x".repeat(60_000)}` }),
      ]),
    ).toContain("This blocked report is final.");
    const output = withHerdrFailures("No managed Herdr agents.", [
      { id: "missing", code: "not_found", message: "No such run." },
    ]);
    expect(output).toContain("Failed targets (1)");
    expect(output).not.toContain("No managed Herdr agents.");
  });

  it("sanitizes and labels terminal diagnostics", () => {
    const output = formatHerdrTerminalRead("herdr-1", "recent-unwrapped", 120, "\u001b[31mboom");
    expect(output).toContain(
      "Herdr terminal output · herdr-1 · recent-unwrapped · up to 120 lines",
    );
    expect(output).toContain("boom");
    expect(output).not.toContain("\u001b[31m");
  });
});
