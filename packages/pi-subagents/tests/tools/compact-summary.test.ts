import { compactIssueSeverity, type CompactIssue } from "pi-code-previews";
import { issueMessageStyleProblems, renderContextFixture } from "pi-code-previews/testing";
import * as Fn from "effect/Function";
import type * as Schema from "effect/Schema";
import { assert, describe, expect, it } from "vitest";
import { agentFailureIssues, failureRecovery } from "../../src/tools/compact-action-failures.ts";
import { createSubagentCompactSummary } from "../../src/tools/compact-summary.ts";
import { SUBAGENT_TOOL_NAME } from "../../src/run/tool-policy.ts";
import { compactToolDetails } from "../../src/tools/details.ts";
import type { SubagentRunView } from "../../src/run/model.ts";
import type {
  CompactSubagentToolDetails,
  SubagentAwaitDetails,
  SubagentStartDetails,
  WorkspaceToolDetails,
} from "../../src/tools/details-schema.ts";
import { view } from "./fixtures/tool-harness.ts";
import * as Arr from "effect/Array";
import * as Str from "effect/String";

type SummarizedDetails =
  | CompactSubagentToolDetails
  | SubagentAwaitDetails
  | SubagentStartDetails
  | WorkspaceToolDetails
  | Schema.Json
  | undefined;

function summarize(
  action: keyof typeof SUBAGENT_TOOL_NAME,
  details: SummarizedDetails,
  phase: "running" | "settled" = "settled",
  args: {
    action?: string;
    runIds?: string[];
    profile?: string;
    agents?: { name: string; profile: string }[];
  } = {},
  isError = false,
) {
  const provider = createSubagentCompactSummary(SUBAGENT_TOOL_NAME[action]);
  return provider({
    phase,
    args,
    result: { content: [{ type: "text", text: "Untrusted success text" }], details },
    context: renderContextFixture({ isError }),
  });
}

const issueDetails = (issues: readonly CompactIssue[] | undefined) =>
  Arr.join(
    Arr.map(issues ?? [], (issue) => issue.detail ?? ""),
    "\n",
  );
const messages = (issues: readonly CompactIssue[] | undefined) =>
  Arr.join(
    Arr.map(issues ?? [], (issue) => issue.message),
    "\n",
  );
it("treats cleanup quarantine as warning rather than failed work or successful stop", () => {
  const run = view({
    state: "completed",
    finalText: "Accepted report sentinel",
    writeIntent: "writer",
    cleanup: {
      disposition: "quarantined",
      recovery: "stop",
      diagnostic: {
        phase: "process-group",
        code: "group_live",
        message: "Diagnostic evidence sentinel",
      },
    },
    writerCleanupQuarantined: true,
  });
  for (const action of ["interrupt", "stop"] as const) {
    const summary = summarize("lifecycle", compactToolDetails({ action, runs: [run] }), "settled", {
      action,
    });
    expect(summary?.outcome).toBe("warning");
    assert(summary?.issues !== undefined);
    expect(Arr.some(summary.issues, (issue) => issue.severity === "error")).toBe(false);
    expect(
      Arr.flatMap(summary?.issues ?? [], (issue) => issueMessageStyleProblems(issue.message)),
    ).toEqual([]);
    expect(messages(summary?.issues)).not.toContain("Diagnostic evidence sentinel");
    expect(issueDetails(summary?.issues)).toContain("Diagnostic evidence sentinel");
  }
  const awaited = summarize(
    "await",
    awaitReceipt([run], {
      awaitedRunIds: [run.id],
      attentionRequired: true,
    }),
    "settled",
    { runIds: [run.id] },
  );
  expect(awaited?.outcome).toBe("warning");
  assert(awaited?.issues !== undefined);
  expect(Arr.some(awaited.issues, (issue) => issue.code === "parent-action")).toBe(false);
  expect(Arr.filter(awaited.issues, (issue) => issue.severity === "warning")).toHaveLength(1);
  const context = summarize(
    "await",
    awaitReceipt([view({ id: "target", state: "completed" }), { ...run, finalText: undefined }], {
      awaitedRunIds: ["target"],
      attentionRequired: true,
    }),
    "settled",
    { runIds: ["target"] },
  );
  expect(issueDetails(context?.issues)).toContain("Diagnostic evidence sentinel");
  assert(context?.issues !== undefined);
  expect(Arr.some(context.issues, (issue) => issue.code === "parent-action")).toBe(false);
  const confirmed = summarize(
    "lifecycle",
    compactToolDetails({
      action: "stop",
      runs: [
        {
          ...run,
          cleanup: { disposition: "confirmed" },
          writerCleanupQuarantined: false,
        },
      ],
    }),
    "settled",
    { action: "stop" },
  );
  expect(confirmed?.outcome).toBe("success");
});

const pending = {
  index: 0,
  name: "worker",
  profile: "worker",
  status: "pending",
  routeStatus: "resolving",
};
const selected = {
  ...pending,
  status: "started",
  routeStatus: "selected",
  runtime: "pi",
  model: "provider/model",
  effort: "low",
  openaiFastMode: false,
};

const stoppedOf = (...runs: ReadonlyArray<Partial<SubagentRunView>>) =>
  compactToolDetails({ action: "stop", runs: Arr.map(runs, (run) => view(run)) });

const awaitReceipt = (
  runs: ReadonlyArray<SubagentRunView>,
  extra: Partial<SubagentAwaitDetails> = {},
) => {
  const projected = stoppedOf(...runs);
  if (projected.action === "models") throw new Error("Expected cards");
  return {
    version: 2,
    action: "await",
    cards: projected.cards,
    awaitUntil: "all_finished",
    ...extra,
  };
};

const worktreeWriter = (workspaceOutcome?: SubagentRunView["workspaceOutcome"]) =>
  view({
    state: "completed",
    finalText: "Done",
    writeIntent: "writer",
    writerWorkspaceMode: "worktree",
    workspaceId: "ws-1",
    ...(workspaceOutcome && { workspaceOutcome }),
  });
const stopSummary = (run: SubagentRunView) =>
  summarize("lifecycle", stoppedOf(run), "settled", { action: "stop", runIds: [run.id] });

describe("worktree writer workspace outcomes", () => {
  it("presents every outcome as information, and only a proposal as changes to review", () => {
    const proposal = stopSummary(worktreeWriter({ status: "proposal", changedFileCount: 2 }));
    const plain = stopSummary(view({ state: "completed", finalText: "Done" }));
    expect(proposal?.counters).not.toEqual(plain?.counters);
    expect(issueDetails(proposal?.issues)).toContain("ws-1");
    for (const status of ["auto-discarded", "integrated", "discarded"] as const) {
      const resolved = stopSummary(worktreeWriter({ status }));
      expect(resolved?.counters).toEqual(plain?.counters);
      expect(issueDetails(resolved?.issues)).not.toContain("agent_worktree apply");
      expect(messages(resolved?.issues)).not.toBe(messages(proposal?.issues));
    }
    for (const summary of [proposal, stopSummary(worktreeWriter({ status: "integrated" }))]) {
      expect(summary?.outcome).toBe("success");
      assert(summary?.issues !== undefined);
      expect(Arr.every(summary.issues, (issue) => issue.severity === "info")).toBe(true);
    }
  });
});

describe("await outcomes", () => {
  it("returns neutrally when the user's message ends the wait", () => {
    const run = view({ id: "agent-1", state: "running" });
    const summary = summarize(
      "await",
      awaitReceipt([run], { awaitedRunIds: [run.id], cancelled: true, endedByUserInput: true }),
      "settled",
      { runIds: [run.id] },
    );
    expect(summary?.outcome).toBe("returned");
  });
});

describe("subagent compact semantic policy", () => {
  it("treats pending and unresolved steering as delivery uncertainty, not worker failure", () => {
    for (const steeringDelivery of ["pending", "unresolved"] as const) {
      for (const state of ["running", "completed"] as const) {
        const run = view({ steeringDelivery, state });
        const summary = summarize("lifecycle", stoppedOf(run), "settled", {
          action: "stop",
          runIds: [run.id],
        });
        expect(summary?.outcome).toBe("uncertain");
        expect(compactIssueSeverity(summary?.issues)).toBe("warning");
        expect(issueDetails(summary?.issues)).toContain(`steeringDelivery=${steeringDelivery}`);
        expect(issueDetails(summary?.issues)).toContain("Do not resend");
        expect(messages(summary?.issues)).not.toContain("failed");
      }
    }
    for (const steeringDelivery of ["confirmed", "not-sent", "report-unconfirmed"] as const) {
      const summary = summarize("lifecycle", stoppedOf({ steeringDelivery }), "settled", {
        action: "stop",
        runIds: ["agent-1"],
      });
      expect(summary?.outcome).toBe(steeringDelivery === "confirmed" ? "success" : "warning");
      expect(issueDetails(summary?.issues)).toContain(`steeringDelivery=${steeringDelivery}`);
    }
  });
  it("never advises resending or retrying an unconfirmed action", () => {
    for (const code of [
      "interrupt_outcome_uncertain",
      "claude_steering_outcome_uncertain",
      "stop_cleanup_unconfirmed",
      "writer_lease_cleanup_unconfirmed",
    ]) {
      const summary = summarize(
        "lifecycle",
        compactToolDetails({
          action: "stop",
          runs: [],
          actionFailures: [{ id: "target", code, message: "Evidence" }],
        }),
        "settled",
        { action: "stop", runIds: ["target"] },
      );
      expect(summary?.issues?.length).toBeGreaterThan(0);
      for (const issue of summary?.issues ?? []) {
        const advice = Fn.pipe(issue.detail ?? "", Str.replace(/Do not resend, retry[^.;]*/g, ""));
        expect(advice).not.toMatch(/\b(resend|retry)\b/i);
      }
    }
  });

  it("writes every issue message in the shared style, without run IDs", () => {
    const id = "run-7f3a";
    const failurePath = "/agent/subagent-reports/session-1/run-7f3a-1-failure.md";
    const runs: Partial<SubagentRunView>[] = [
      { state: "failed", error: "Error: 429 Too Many Requests: rate limit exceeded\n  at stack" },
      { state: "failed", error: "Inspect subagent status before retrying." },
      { state: "failed" },
      { state: "stopped" },
      { state: "stopping" },
      { state: "paused" },
      {
        state: "waiting_for_parent",
        question: { message: "Should I update db/0007.sql?", requestId: "q" },
      },
      { state: "waiting_for_parent" },
      { warning: "Could not run the integration tests: docker is not available" },
      { warning: "Context window 91% full", warningSource: "system", systemWarning: "Other" },
      { selection: { ...view().selection, warning: "Protocol 21 is unsupported. Fell back." } },
      {
        selection: {
          ...view().selection,
          skippedCandidates: [
            {
              candidate: { runtime: "pi", model: "alt", effort: "high" },
              code: "pi_model_unknown",
              reason: "Missing",
            },
          ],
        },
      },
      ...Arr.map(
        ["pending", "confirmed", "not-sent", "report-unconfirmed", "unresolved"] as const,
        (steeringDelivery) => ({ steeringDelivery }),
      ),
      {
        state: "completed",
        finalText: "Done",
        writeIntent: "writer",
        writerWorkspaceMode: "worktree",
      },
      ...Arr.map(
        [
          { status: "auto-discarded" },
          { status: "integrated" },
          { status: "discarded" },
          { status: "proposal", changedFileCount: 1 },
          { status: "proposal", changedFileCount: 4, uncapturedFileCount: 2 },
          {
            status: "proposal",
            changedFileCount: 2,
            diffStat: {
              addedLines: 9,
              deletedLines: 3,
              files: [{ path: "src/a.ts", addedLines: 9, deletedLines: 3 }],
            },
          },
        ] as const,
        (workspaceOutcome) => ({
          state: "completed" as const,
          finalText: "Done",
          writeIntent: "writer" as const,
          writerWorkspaceMode: "worktree" as const,
          workspaceId: "ws-7f3a",
          workspaceOutcome,
        }),
      ),
    ];
    const issues = Arr.flatMap(runs, (overrides) => {
      const run = view({ id, ...overrides });
      return [
        ...(summarize("lifecycle", stoppedOf(run), "settled", { action: "stop", runIds: [run.id] })
          ?.issues ?? []),
        ...(summarize("await", awaitReceipt([run], { awaitedRunIds: [id] }))?.issues ?? []),
      ];
    });
    for (const [message, cleanupDisposition] of [
      ["Prompt rejected: 400 invalid_request_error", "confirmed"],
      ["Start failed", "quarantined"],
    ] as const)
      issues.push(
        ...(summarize("start", {
          version: 2,
          action: "start",
          startEntries: [
            { ...selected, status: "failed" },
            { ...selected, index: 1, warning: "Protocol 21 is unsupported. Fell back." },
          ],
          startFailures: [
            {
              index: 0,
              code: "prompt_rejected",
              message,
              admittedRun: {
                runId: id,
                cleanupDisposition,
                nextCandidate: { runtime: "pi", model: "openai/next", effort: "high" },
                failureFile: { path: failurePath, chars: 900, lines: 3, complete: true },
                warning: "System warning: Provider rate limit reached; retried twice.",
              },
            },
          ],
        })?.issues ?? []),
      );
    expect(issues.length).toBeGreaterThan(runs.length);
    for (const issue of issues)
      expect(
        issueMessageStyleProblems(issue.message, {
          forbidden: [id, "ws-7f3a", failurePath],
          maxLength: 160,
        }),
        issue.message,
      ).toEqual([]);
  });
});

describe("failure recovery routing", () => {
  it("routes a start failure by its exact code before broader code fragments", () => {
    for (const [code, knob] of [
      ["workspace_nested_writer_unsupported", "root"],
      ["session_spend_limit", "sessionSpendLimit"],
    ] as const)
      expect(failureRecovery(code, "Refused.", "start"), code).toContain(knob);
  });

  it("recovers a paused run that can't resume by stopping and replacing it", () => {
    const [issue] = agentFailureIssues(
      "[agent_resume_unsupported] Agent agent-0000000007 on local/claude is paused and cannot be resumed.",
      "send",
      "The agent",
    );
    expect(issue?.detail).toContain("agent_lifecycle");
    expect(issueMessageStyleProblems(issue?.message ?? "")).toEqual([]);
  });
});
