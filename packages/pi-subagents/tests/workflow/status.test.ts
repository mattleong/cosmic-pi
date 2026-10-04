import { describe, expect, it } from "@effect/vitest";
import { workflowStatusText } from "../../src/tools/workflow-format.ts";
import { workflowAttention, type WorkflowAgentAttention } from "../../src/workflow/attention.ts";
import type { WorkflowAgentView, WorkflowRunView } from "../../src/workflow/model.ts";
import { containedWriter, view, workflowAgentView, workflowRunView } from "../fixtures/run-view.ts";

const NOW = 60 * 60_000;

const agent = (index: number, patch: Partial<WorkflowAgentView> = {}): WorkflowAgentView =>
  workflowAgentView({
    callId: index,
    runId: `agent-${index}`,
    label: `item-${index}`,
    state: "completed",
    queuedAt: 0,
    startedAt: 1_000,
    endedAt: 2_000,
    ...patch,
  });

const running = (index: number, startedAt: number) =>
  agent(index, { state: "running", startedAt, endedAt: undefined });

const run = (
  agents: ReadonlyArray<WorkflowAgentView>,
  patch: Partial<WorkflowRunView> = {},
): WorkflowRunView =>
  workflowRunView({
    name: "migrate",
    description: "Migrate every module",
    phases: [{ title: "Migrate" }],
    startedAt: 0,
    agents,
    ...patch,
  });

/** The distinct agent run ids a status text names. */
const namedRunIds = (text: string): ReadonlySet<string> =>
  new Set(text.match(/\bagent-\d+\b/gu) ?? []);

describe("workflow status", () => {
  it("counts a phase whose calls were all reused as having agents", () => {
    const text = workflowStatusText(
      run([], {
        phases: [{ title: "Review" }],
        reused: 3,
        reusedPhases: [{ title: "Review", count: 3 }],
      }),
      NOW,
    );
    const review = text.split("\n").find((line) => line.startsWith("- Review")) ?? "";
    expect(review).toMatch(/\b3\b/u);
    expect(review).not.toContain("no agents");
  });

  it("lists running agents with their run ids before agents that ended or wait", () => {
    const text = workflowStatusText(
      run([
        agent(1),
        agent(2, { state: "queued", startedAt: undefined, endedAt: undefined }),
        agent(3, { state: "failed", reason: "tests failed" }),
        running(4, 30 * 60_000),
        running(5, 5 * 60_000),
      ]),
      NOW,
    );
    const at = (fact: string) => text.indexOf(fact);
    // The longest-running agent comes first, so a stuck one is easy to name.
    expect(at("agent-5")).toBeGreaterThan(-1);
    expect(at("agent-5")).toBeLessThan(at("agent-4"));
    expect(at("agent-4")).toBeLessThan(at("agent-3"));
    expect(at("agent-3")).toBeLessThan(at("item-2"));
    expect(text).toContain("tests failed");
    // A completed agent isn't listed by id, only counted, and a queued agent has no subagent yet.
    expect(namedRunIds(text).has("agent-1")).toBe(false);
    expect(namedRunIds(text).has("agent-2")).toBe(false);
  });

  it("stays bounded for a run with 200 agents and keeps every group visible", () => {
    const reason = "r".repeat(5_000);
    const agents = [
      ...Array.from({ length: 150 }, (_, index) => agent(index + 1)),
      ...Array.from({ length: 16 }, (_, index) => running(151 + index, index * 1_000)),
      ...Array.from({ length: 20 }, (_, index) => agent(167 + index, { state: "failed", reason })),
      ...Array.from({ length: 14 }, (_, index) =>
        agent(187 + index, {
          state: "queued",
          startedAt: undefined,
          endedAt: undefined,
          waiting: { kind: "slot" },
        }),
      ),
    ];
    const text = workflowStatusText(run(agents), NOW);
    const named = namedRunIds(text);
    expect(named.size).toBeLessThanOrEqual(24);
    // The oldest running agent, a failed one and a queued one all keep a row.
    for (const runId of ["agent-151", "agent-167"]) expect(named.has(runId)).toBe(true);
    expect(text).toContain("item-187");
    expect(text.length).toBeLessThan(12 * 1024);
    expect(text).not.toContain("r".repeat(500));
  });

  it("names pending questions, paused writers and agents queued behind them", () => {
    const attention: ReadonlyArray<WorkflowAgentAttention> = [
      {
        kind: "question",
        runId: "agent-3",
        message: "Should I migrate both invoice formats?",
        writer: false,
      },
      { kind: "paused", runId: "agent-4", writer: true, canResume: true },
    ];
    const text = workflowStatusText(
      run([
        running(3, 0),
        running(4, 0),
        agent(5, {
          label: "fix:billing",
          state: "queued",
          startedAt: undefined,
          endedAt: undefined,
          // A root writer the user paused, which only its run id targets.
          waiting: { kind: "writer", runId: "agent-90", name: "root-writer", paused: true },
        }),
      ]),
      NOW,
      attention,
    );
    const lineWith = (fact: string) => text.split("\n").find((line) => line.includes(fact)) ?? "";
    const question = lineWith("Should I migrate both invoice formats?");
    expect(question).toContain("agent-3");
    expect(question).toContain("subagent_reply");
    expect(lineWith("fix:billing")).toContain("agent-90");
    expect(text).toContain("agent-4");

    const calm = workflowStatusText(run([running(3, 0)]), NOW);
    expect(calm).not.toContain("subagent_reply");
  });

  it("finds what the subagents of running agents need, by subagent_status's precedence", () => {
    const current = run([...[1, 2, 3, 5, 6, 7, 8].map((index) => running(index, 0)), agent(4)]);
    const question = { requestId: "q-1", message: "Which module?", createdAt: 1 };
    expect(
      workflowAttention(current, [
        view({ id: "agent-1", state: "waiting_for_parent", question }),
        view({ id: "agent-2", state: "paused", writeIntent: "writer" }),
        view({ id: "agent-3", state: "running" }),
        // A finished agent's subagent no longer holds the run up.
        view({ id: "agent-4", state: "paused" }),
        // Paused by its own claim violation, not by a person.
        containedWriter({ id: "agent-5", state: "paused" }),
        view({ id: "agent-6", state: "paused", capabilities: ["steer", "interrupt"] }),
        view({ id: "agent-7", writeIntent: "writer", writeAdmissionPaused: true }),
        view({ id: "agent-8", state: "waiting_for_parent" }),
      ]),
    ).toEqual([
      { kind: "question", runId: "agent-1", message: "Which module?", writer: false },
      { kind: "paused", runId: "agent-2", writer: true, canResume: true },
      { kind: "containment", runId: "agent-5", writer: true },
      { kind: "paused", runId: "agent-6", writer: false, canResume: false },
      { kind: "admission-paused", runId: "agent-7", writer: true },
      { kind: "question-unavailable", runId: "agent-8", writer: false },
    ]);
  });

  it("sends a contained writer to its claim recovery and never resumes an unresumable agent", () => {
    // Without agent rows, each run id appears only on its attention line.
    const text = workflowStatusText(run([]), NOW, [
      { kind: "containment", runId: "agent-1", writer: true },
      { kind: "paused", runId: "agent-2", writer: false, canResume: false },
    ]);
    const lineWith = (fact: string) => text.split("\n").find((line) => line.includes(fact)) ?? "";
    const contained = lineWith("agent-1");
    expect(contained).toContain("subagent_status");
    expect(contained).toContain("resume_admission");
    const unresumable = lineWith("agent-2");
    expect(unresumable).toContain("subagent_lifecycle");
    expect(unresumable).not.toContain('"resume"');
  });

  it("bounds worktrees, log lines and the error stack", () => {
    const text = workflowStatusText(
      run(
        Array.from({ length: 60 }, (_, index) =>
          agent(index + 1, { workspaceId: `workspace-${index + 1}` }),
        ),
        {
          state: "failed",
          endedAt: 10_000,
          logs: [{ at: 1, level: "info", message: "l".repeat(2_000) }],
          failure: { name: "TypeError", message: "boom", stack: "s".repeat(20_000) },
        },
      ),
      NOW,
    );
    expect(new Set(text.match(/\bworkspace-\d+\b/gu)).size).toBeLessThanOrEqual(40);
    expect(text).not.toContain("l".repeat(401));
    expect(text).not.toContain("s".repeat(8 * 1024));
    expect(text.length).toBeLessThan(16 * 1024);
  });

  it("lists only worktree proposals that hold changes and counts the discarded ones", () => {
    const writers = [1, 2, 3, 4].map((index) =>
      agent(index, {
        workspaceId: `workspace-${index}`,
        ...(index !== 3 && { unchanged: true as const }),
      }),
    );
    const text = workflowStatusText(run(writers, { state: "completed", endedAt: 2_000 }), NOW);
    expect(text).toContain("workspace-3");
    for (const discarded of ["workspace-1", "workspace-2", "workspace-4"])
      expect(text).not.toContain(discarded);
    // The count is on a line of its own, apart from the listed proposal.
    expect(
      text.split("\n").some((line) => /\b3\b/u.test(line) && !line.includes("workspace-")),
    ).toBe(true);
  });
});
