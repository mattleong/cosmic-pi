import { compactIssueSeverity, type CompactIssue } from "pi-code-previews";
import { issueMessageStyleProblems, renderContextFixture } from "pi-code-previews/testing";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { createSubagentCompactSummary } from "../../src/tools/compact-summary.ts";
import { compactToolDetails } from "../../src/tools/details.ts";
import type { SubagentRunView } from "../../src/run/model.ts";
import type {
  CompactSubagentToolDetails,
  SubagentAwaitDetails,
  SubagentStartDetails,
  WorkspaceToolDetails,
} from "../../src/tools/details-schema.ts";
import { view } from "./fixtures/tool-harness.ts";

type SummarizedDetails =
  | CompactSubagentToolDetails
  | SubagentAwaitDetails
  | SubagentStartDetails
  | WorkspaceToolDetails
  | Schema.Json
  | undefined;

function summarize(
  action: string,
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
  const provider = createSubagentCompactSummary(`subagent_${action}`);
  return provider({
    phase,
    args,
    result: { content: [{ type: "text", text: "Untrusted success text" }], details },
    context: renderContextFixture({ isError }),
  });
}

const issueDetails = (issues: readonly CompactIssue[] | undefined) =>
  (issues ?? []).map((issue) => issue.detail ?? "").join("\n");
const messages = (issues: readonly CompactIssue[] | undefined) =>
  (issues ?? []).map((issue) => issue.message).join("\n");
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
  for (const action of ["status", "stop"] as const) {
    const summary = summarize(
      action === "stop" ? "lifecycle" : action,
      compactToolDetails({ action, runs: [run] }),
      "settled",
      { action },
    );
    expect(summary?.outcome).toBe("warning");
    expect(summary?.issues?.some((issue) => issue.severity === "error")).toBe(false);
    expect(
      (summary?.issues ?? []).flatMap((issue) => issueMessageStyleProblems(issue.message)),
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
  expect(awaited?.issues?.some((issue) => issue.code === "parent-action")).toBe(false);
  expect(awaited?.issues?.filter((issue) => issue.severity === "warning")).toHaveLength(1);
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
  expect(context?.issues?.some((issue) => issue.code === "parent-action")).toBe(false);
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

const statusOf = (...runs: ReadonlyArray<Partial<SubagentRunView>>) =>
  compactToolDetails({ action: "status", runs: runs.map((run) => view(run)) });

const awaitReceipt = (
  runs: ReadonlyArray<SubagentRunView>,
  extra: Partial<SubagentAwaitDetails> = {},
) => {
  const projected = statusOf(...runs);
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
const statusSummary = (run: SubagentRunView) =>
  summarize("status", statusOf(run), "settled", { runIds: [run.id] });

describe("worktree writer workspace outcomes", () => {
  it("presents both outcomes as information, and only a proposal as changes to review", () => {
    const discarded = statusSummary(worktreeWriter({ status: "auto-discarded" }));
    const proposal = statusSummary(worktreeWriter({ status: "proposal", changedFileCount: 2 }));
    const plain = statusSummary(view({ state: "completed", finalText: "Done" }));
    for (const summary of [discarded, proposal]) {
      expect(summary?.outcome).toBe("success");
      expect(summary?.issues?.every((issue) => issue.severity === "info")).toBe(true);
    }
    expect(discarded?.counters).toEqual(plain?.counters);
    expect(proposal?.counters).not.toEqual(plain?.counters);
    expect(issueDetails(proposal?.issues)).toContain("ws-1");
    expect(messages(discarded?.issues)).not.toBe(messages(proposal?.issues));
  });
});

describe("subagent compact semantic policy", () => {
  it("treats pending and unresolved steering as delivery uncertainty, not worker failure", () => {
    for (const steeringDelivery of ["pending", "unresolved"] as const) {
      for (const state of ["running", "completed"] as const) {
        const run = view({ steeringDelivery, state });
        const status = statusOf(run);
        const summary = summarize("status", status, "settled", { runIds: [run.id] });
        expect(summary?.outcome).toBe("uncertain");
        expect(compactIssueSeverity(summary?.issues)).toBe("warning");
        expect(issueDetails(summary?.issues)).toContain(`steeringDelivery=${steeringDelivery}`);
        expect(issueDetails(summary?.issues)).toContain("Do not resend");
        expect(messages(summary?.issues)).not.toContain("failed");
      }
    }
    for (const steeringDelivery of ["confirmed", "not-sent", "report-unconfirmed"] as const) {
      const summary = summarize("status", statusOf({ steeringDelivery }), "settled", {
        runIds: ["agent-1"],
      });
      expect(summary?.outcome).toBe(steeringDelivery === "confirmed" ? "success" : "warning");
      expect(issueDetails(summary?.issues)).toContain(`steeringDelivery=${steeringDelivery}`);
    }
  });
  it("never advises resending or retrying an unconfirmed or pending action", () => {
    for (const code of [
      "steer_outcome_uncertain",
      "claude_steering_outcome_uncertain",
      "stop_cleanup_unconfirmed",
      "writer_lease_cleanup_unconfirmed",
    ]) {
      for (const pendingDelivery of [false, true]) {
        const summary = summarize(
          "send",
          compactToolDetails({
            action: "send",
            runs: [],
            actionFailures: [
              {
                id: "target",
                code,
                message: "Evidence",
                ...(pendingDelivery && { pendingDelivery: true as const }),
              },
            ],
          }),
        );
        for (const issue of summary?.issues ?? []) {
          const advice = (issue.detail ?? "").replace(/Do not resend, retry[^.;]*/g, "");
          expect(advice).not.toMatch(/\b(resend|retry)\b/i);
        }
      }
    }
  });

  it("writes every issue message in the shared style, without run IDs", () => {
    const id = "run-7f3a";
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
      ...(["pending", "confirmed", "not-sent", "report-unconfirmed", "unresolved"] as const).map(
        (steeringDelivery) => ({ steeringDelivery }),
      ),
      {
        state: "completed",
        finalText: "Done",
        writeIntent: "writer",
        writerWorkspaceMode: "worktree",
      },
      ...(
        [
          { status: "auto-discarded" },
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
        ] as const
      ).map((workspaceOutcome) => ({
        state: "completed" as const,
        finalText: "Done",
        writeIntent: "writer" as const,
        writerWorkspaceMode: "worktree" as const,
        workspaceId: "ws-7f3a",
        workspaceOutcome,
      })),
    ];
    const issues = runs.flatMap((overrides) => {
      const run = view({ id, ...overrides });
      return [
        ...(summarize("status", statusOf(run), "settled", { runIds: [run.id] })?.issues ?? []),
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
                retryDisposition: "eligible",
                hasRemainingCandidate: true,
                remainingCandidateCount: 1,
              },
            },
          ],
        })?.issues ?? []),
      );
    expect(issues.length).toBeGreaterThan(runs.length);
    for (const issue of issues)
      expect(
        issueMessageStyleProblems(issue.message, { forbidden: [id, "ws-7f3a"], maxLength: 160 }),
        issue.message,
      ).toEqual([]);
  });
});
