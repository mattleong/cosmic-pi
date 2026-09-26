import { compactIssueSeverity, type CompactIssue } from "pi-code-previews";
import { renderContextFixture } from "pi-code-previews/testing";
import { describe, expect, it } from "vitest";
import { createSubagentCompactSummary } from "../../src/tools/compact-summary.ts";
import { makeCompactToolDetails } from "../../src/tools/details.ts";
import type { SubagentRunView } from "../../src/run/model.ts";
import type { SubagentAwaitDetails, WorkspaceToolDetails } from "../../src/tools/details-schema.ts";
import { view } from "./fixtures/tool-harness.ts";

function summarize<DetailsInput>(
  action: string,
  details: DetailsInput,
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

const workspace = (
  operation: WorkspaceToolDetails["operation"],
  receipt: Partial<WorkspaceToolDetails> = {},
) =>
  summarize("workspace", { version: 1, action: "workspace", operation, ...receipt }, "settled", {
    action: operation,
  });

const details = (issues: readonly CompactIssue[] | undefined) =>
  (issues ?? []).map((issue) => issue.detail ?? "").join("\n");
const messages = (issues: readonly CompactIssue[] | undefined) =>
  (issues ?? []).map((issue) => issue.message).join("\n");

/** Launch entries before and after route selection. */
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
  host: "local",
  runtime: "pi",
  model: "provider/model",
  effort: "low",
  openaiFastMode: false,
};

/** An await receipt over status-projected cards that states target scope only through `extra`. */
const awaitReceipt = (
  runs: ReadonlyArray<SubagentRunView>,
  extra: Partial<SubagentAwaitDetails> = {},
) => {
  const projected = makeCompactToolDetails({ action: "status", runs });
  if (projected.action === "models") throw new Error("Expected cards");
  return {
    version: 2,
    action: "await",
    cards: projected.cards,
    awaitUntil: "all_finished",
    ...extra,
  };
};

describe("subagent compact semantic policy", () => {
  it("attributes issues to each run and keeps raw warning prose on expansion", () => {
    const summary = summarize(
      "list",
      makeCompactToolDetails({
        action: "list",
        runs: [view({ id: "one", state: "stopping" }), view({ id: "two", state: "stopping" })],
      }),
    );
    expect(summary?.issues?.map((issue) => [issue.severity, issue.code])).toEqual([
      ["warning", "one:cleanup-pending"],
      ["warning", "two:cleanup-pending"],
    ]);
    expect(messages(summary?.issues)).not.toMatch(/\bone\b|\btwo\b/);
    const unknown = summarize(
      "status",
      makeCompactToolDetails({
        action: "status",
        runs: [view({ id: "one", warning: "Review external ownership before retrying." })],
      }),
    );
    expect(unknown?.outcome).toBe("warning");
    expect(messages(unknown?.issues)).not.toContain("Review external ownership");
    expect(details(unknown?.issues)).toContain("Review external ownership before retrying.");
  });
  it("uses start names or profiles before launch and combines observed state counts", () => {
    const provider = createSubagentCompactSummary("subagent_start");
    for (const agent of [{ name: "Review auth", profile: "reviewer" }, { profile: "reviewer" }]) {
      const summary = provider({
        args: { agents: [agent] },
        phase: "running",
        result: undefined,
        context: renderContextFixture(),
      });
      expect(summary?.subject).toBe("name" in agent ? agent.name : agent.profile);
      expect(summary?.counters?.join(" ")).not.toContain("finished");
    }
    const summary = summarize(
      "list",
      makeCompactToolDetails({
        action: "list",
        runs: [view({ id: "one", state: "running" }), view({ id: "two", state: "completed" })],
      }),
    );
    expect(summary?.counters).toHaveLength(1);
    expect(summary?.counters?.[0]).toContain("1 running");
    expect(summary?.counters?.[0]).toContain("1 completed");
    expect(summary?.metadata).toEqual([]);
  });
  it("keeps a requested target separate from lifecycle operations throughout rendering", () => {
    const provider = createSubagentCompactSummary("subagent_lifecycle");
    const args = { action: "interrupt", runIds: ["target-1"] };
    for (const phase of ["pending", "running", "settled"] as const) {
      const summary = provider({
        phase,
        args,
        result:
          phase === "pending"
            ? undefined
            : {
                content: [],
                details: makeCompactToolDetails({
                  action: "interrupt",
                  runs: [view({ id: "target-1", name: "Worker", state: "running" })],
                }),
              },
        context: renderContextFixture(),
      });
      expect(summary?.subject).toBe(phase === "pending" ? "target-1" : "Worker");
      expect(summary?.action).toBe("interrupt");
      expect(summary?.metadata).not.toContain("target-1");
    }
  });

  it("retains a retry successor distinct from the requested source without duplicate identity", () => {
    for (const name of ["Retry worker", "source-1", "successor-2"]) {
      const summary = summarize(
        "lifecycle",
        makeCompactToolDetails({
          action: "retry",
          runs: [view({ id: "successor-2", name, state: "running" })],
        }),
        "settled",
        { action: "retry", runIds: ["source-1"] },
      );
      expect(summary?.action).toBe("retry");
      expect(summary?.subject).toBe("source-1");
      expect(summary?.metadata).not.toContain("successor-2");
      expect(summary?.metadata).not.toContain("source-1");
      expect(summary?.issues).toEqual([]);
    }
  });

  it("uses decoded run states rather than output text", () => {
    const details = makeCompactToolDetails({
      action: "status",
      runs: [view({ state: "running" })],
    });
    const summary = summarize("status", details);
    expect(summary?.outcome).toBe("success");
    expect(summary?.counters).toContain("running");
    expect(summary?.metadata?.join(" ")).not.toContain("Untrusted");
  });

  it("does not present an incomplete or different target as a single named run", () => {
    const details = makeCompactToolDetails({
      action: "status",
      runs: [view({ id: "visible", name: "Visible", state: "running" })],
    });
    for (const sample of [
      { details, ids: ["visible", "missing"] },
      { details: { ...details, runCount: 2 }, ids: ["visible"] },
      { details, ids: ["missing"] },
    ]) {
      const summary = summarize("status", sample.details, "settled", { runIds: sample.ids });
      expect(summary?.counters?.join(" ")).toContain("1 running");
    }
  });

  it("summarizes stable writer claims without treating them as blocked admission", () => {
    const details = makeCompactToolDetails({
      action: "status",
      runs: [view({ state: "running", writeIntent: "writer", writeClaims: ["src/a.ts"] })],
    });
    expect(summarize("status", details)?.outcome).toBe("success");
    expect(summarize("status", details)?.metadata).toEqual([]);
  });

  it("declines missing, mismatched, omitted and old details", () => {
    for (const details of [
      undefined,
      {},
      { version: 1, action: "status" },
      makeCompactToolDetails({ action: "list", runs: [] }),
    ]) {
      expect(summarize("status", details)).toBeUndefined();
    }
  });

  it("keeps attention visible while moving agent procedures and IDs to expansion", () => {
    for (const overrides of [
      {
        state: "waiting_for_parent" as const,
        question: { message: "May I edit another file?", requestId: "q-1", createdAt: 1 },
      },
      { state: "paused" as const },
      { state: "failed" as const, error: "Cleanup uncertain" },
      { writeIntent: "writer" as const, writeClaims: ["src/a.ts"], writeAdmissionPaused: true },
      { warning: "Fallback changed runtime" },
    ]) {
      const card = view({ id: "PRIVATE-RUN", ...overrides });
      const projected = makeCompactToolDetails({ action: "status", runs: [card] });
      for (const phase of ["running", "settled"] as const) {
        const issues = summarize("status", projected, phase)?.issues;
        expect(compactIssueSeverity(issues)).toBeDefined();
        expect(messages(issues)).not.toMatch(/PRIVATE-RUN|subagent_|May I edit|Fallback/);
        expect(details(issues)).toContain("PRIVATE-RUN");
      }
    }
  });

  it("reports live launch progress without prematurely classifying success", () => {
    const details = { version: 2, action: "start", startEntries: [pending] };
    const args = { agents: [{ name: "worker", profile: "worker" }] };
    expect(summarize("start", details, "running", args)?.counters).toContain("0/1 started");
    expect(summarize("start", details, "running", args)?.outcome).toBeUndefined();
    expect(summarize("start", details, "settled", args)?.outcome).toBe("uncertain");
    const started = { ...details, startEntries: [{ ...selected, runId: "started-1" }] };
    for (const phase of ["running", "settled"] as const) {
      const summary = summarize("start", started, phase, args);
      expect(summary?.subject).toBe("worker");
      expect(summary?.counters).toContain("started");
      expect(summary?.outcome).toBe(phase === "running" ? undefined : "success");
    }
    expect(summarize("start", started)?.counters).toContain("1/1 started");
  });

  it("does not promote changing launch-entry details into live identity or metadata", () => {
    for (const changed of [false, true]) {
      const details = {
        version: 2,
        action: "start",
        startEntries: [
          {
            ...selected,
            name: changed ? "Renamed" : "Worker",
            runId: "started-1",
            writerWorkspaceMode: changed ? "worktree" : "shared-checkout",
          },
          { ...pending, index: 1, name: "Pending" },
        ],
      };
      const summary = summarize("start", details, "running");
      expect(summary?.subject).toBe("");
      expect(summary?.counters).toEqual(["1/2 started"]);
      expect(summary?.metadata).toEqual([]);
    }
  });

  it("promotes the sole listed identity but not a partial multi-target status", () => {
    for (const action of ["list", "status"] as const) {
      const details = makeCompactToolDetails({
        action,
        runs: [view({ id: "only-1", name: "Worker" })],
      });
      expect(summarize(action, details)?.subject).toBe("Worker");
      expect(summarize(action, details)?.metadata).not.toContain("only-1");
      expect(summarize(action, details, "settled", { runIds: ["only-1", "other"] })?.subject).toBe(
        "",
      );
    }
  });

  it("requires target scope before summarizing awaits", () => {
    expect(
      summarize("await", { version: 2, action: "await", cards: [], awaitUntil: "all_finished" }),
    ).toBeUndefined();
    expect(
      summarize(
        "await",
        {
          version: 2,
          action: "await",
          cards: [],
          awaitUntil: "all_finished",
          attentionRequired: true,
        },
        "running",
      ),
    ).toBeUndefined();
  });

  it.each(["send", "reply"] as const)(
    "counts only accepted %s operations and retains failures",
    (action) => {
      for (const accepted of [0, 1, 2]) {
        const runs = Array.from({ length: accepted }, (_, index) =>
          view({ id: `accepted-${index}`, state: "running" }),
        );
        const details = makeCompactToolDetails({
          action,
          runs,
          actionFailures: [{ id: "missing", code: "run_not_found", message: "Run not found" }],
        });
        const summary = summarize(action, details);
        const receipt = summary?.counters?.join(" ");
        expect(receipt).toContain(action === "send" ? "sent" : "replied");
        expect(receipt?.match(/\d+/g) ?? []).toEqual(accepted === 1 ? [] : [String(accepted)]);
        expect(summary?.outcome).toBe("error");
        expect(
          summary?.issues?.some(
            (issue) => issue.severity === "error" && issue.detail?.includes("missing"),
          ),
        ).toBe(true);
        const live = summarize(action, details, "running");
        expect(live?.counters?.join(" ")).not.toMatch(/sent|replied/);
      }
      const success = summarize(action, makeCompactToolDetails({ action, runs: [view()] }));
      expect(success?.outcome).toBe("success");
      const bounded = summarize(action, {
        ...makeCompactToolDetails({ action, runs: [view()] }),
        runCount: 3,
      });
      expect(bounded?.counters?.join(" ")).toContain("3");
      expect(bounded?.counters?.join(" ")).toContain("1/3");
      expect(
        bounded?.issues?.some(
          (issue) => issue.code === "runs-omitted" && issue.severity === "warning",
        ),
      ).toBe(true);
    },
  );

  it("classifies action failures and keeps their target IDs on expansion", () => {
    const projected = makeCompactToolDetails({
      action: "send",
      runs: [],
      actionFailures: [{ id: "agent-1", code: "run_not_found", message: "Run not found" }],
    });
    const summary = summarize("send", projected);
    expect(summary?.outcome).toBe("error");
    expect(compactIssueSeverity(summary?.issues)).toBe("error");
    expect(messages(summary?.issues)).not.toContain("agent-1");
    expect(details(summary?.issues)).toContain("agent-1");
  });

  it.each([
    ["stopped", "cancelled"],
    ["stopping", "uncertain"],
    ["paused", "warning"],
    ["waiting_for_parent", "warning"],
  ] as const)("classifies %s without a clean success icon", (state, outcome) => {
    const details = makeCompactToolDetails({ action: "status", runs: [view({ state })] });
    expect(summarize("status", details)?.outcome).toBe(outcome);
    expect(summarize("status", details, "settled", {}, true)).toBeUndefined();
  });

  it.each([{}, { awaitedRunIds: ["context"] }])(
    "uses exact requested targets with absent or conflicting projected scope",
    (scope) => {
      const summary = summarize(
        "await",
        awaitReceipt(
          [view({ id: "target", state: "completed" }), view({ id: "context", state: "paused" })],
          scope,
        ),
        "settled",
        { runIds: ["target"] },
      );
      expect(summary?.counters).toContain("finished");
      expect(summary?.subject).toBe("auth-review");
      expect(summary?.metadata).not.toContain("target");
      expect(summary?.metadata).not.toContain("1 paused");
    },
  );

  it("keeps quarantine ahead of route-exhaustion replacement advice", () => {
    const summary = summarize("start", {
      version: 2,
      action: "start",
      startEntries: [{ ...selected, status: "failed" }],
      startFailures: [
        {
          index: 0,
          message: "Start failed",
          admittedRun: {
            runId: "quarantined-run",
            cleanupDisposition: "quarantined",
            retryDisposition: "exhausted",
            hasRemainingCandidate: false,
            remainingCandidateCount: 0,
          },
        },
      ],
    });
    expect(summary?.outcome).toBe("error");
    expect(
      summary?.issues?.find((issue) => issue.code.endsWith(":cleanup-receipt"))?.severity,
    ).toBe("warning");
    const text = details(summary?.issues);
    expect(text).toContain("quarantined-run");
    expect(text).toContain("quarantined");
    expect(text).toContain("Do not retry or launch a replacement");
    expect(text).not.toContain("only now consider");
    expect(messages(summary?.issues)).not.toContain("quarantined-run");
  });

  it("keeps confirmed launch cleanup as expanded-only recovery beside the start error", () => {
    const summary = summarize("start", {
      version: 2,
      action: "start",
      startEntries: [{ ...selected, status: "failed" }],
      startFailures: [
        {
          index: 0,
          message: "Start failed",
          admittedRun: {
            runId: "cleaned-run",
            cleanupDisposition: "confirmed",
            retryDisposition: "eligible",
            hasRemainingCandidate: true,
            remainingCandidateCount: 1,
          },
        },
      ],
    });
    expect(summary?.outcome).toBe("error");
    expect(summary?.issues?.map((issue) => issue.severity)).toEqual(["error", "info", "info"]);
    expect(details(summary?.issues)).toContain('action: "retry"');
  });

  it("matches claims operations to the claims detail family", () => {
    const details = makeCompactToolDetails({
      action: "claims",
      runs: [view({ writeIntent: "writer", writeClaims: ["src/a.ts"] })],
    });
    const summary = summarize("claims", details, "settled", { action: "list" });
    expect(summary?.action).toBe("list");
    expect(summary?.counters).toContain("1 file claim");
    expect(summary?.metadata?.join(" ")).not.toContain("src/a.ts");
    expect(
      summarize("claims", makeCompactToolDetails({ action: "list", runs: [] }), "settled", {
        action: "list",
      }),
    ).toBeUndefined();
  });

  it("branches paused recovery on capabilities", () => {
    for (const resumable of [true, false]) {
      const projected = makeCompactToolDetails({
        action: "interrupt",
        runs: [view({ state: "paused", capabilities: resumable ? ["resume"] : [] })],
      });
      const text = details(
        summarize("lifecycle", projected, "settled", { action: "interrupt" })?.issues,
      );
      expect(text).toContain(resumable ? 'action: "resume"' : 'action: "stop"');
      expect(text).toContain(resumable ? "subagent_await" : "confirm cleanup");
      if (!resumable) expect(text).not.toContain('action: "resume"');
    }
  });

  it("does not grant from projected offender audits or change peer claims", () => {
    for (const offender of [true, false]) {
      const projected = makeCompactToolDetails({
        action: "status",
        runs: [
          view({
            state: "paused",
            writeIntent: "writer",
            writeAdmissionPaused: true,
            ...(offender && { writeViolationOffender: true }),
            writeClaims: ["src/a.ts"],
            writeAudit: { observedFileWrites: [], violations: [], bashWriteHints: 0 },
          }),
        ],
      });
      const text = details(summarize("status", projected)?.issues);
      expect(text).not.toContain("paths:");
      expect(text).not.toContain("src/a.ts");
      if (offender) {
        expect(text).toContain("full audit");
        expect(text.indexOf('action: "resume_admission"')).toBeLessThan(
          text.indexOf('action: "resume"'),
        );
        expect(text).toContain("outside the workspace");
        expect(text).toContain("confirm process and writer cleanup");
      } else {
        expect(text).toContain("Do not change this peer's claims");
        expect(text).not.toContain('action: "resume"');
      }
    }
  });

  it("summarizes only await targets and leaves report bodies on expansion", () => {
    const receipt = awaitReceipt(
      [
        view({ id: "target", state: "completed", finalText: "SECRET REPORT BODY" }),
        view({ id: "descendant", state: "paused", parentRunId: "target" }),
      ],
      { awaitedRunIds: ["target"] },
    );
    const summary = summarize("await", receipt);
    expect(summary?.metadata).not.toContain("1 completed");
    expect(summary?.counters).toContain("finished");
    expect(summary?.metadata).not.toContain("1 paused");
    const text = `${messages(summary?.issues)}\n${details(summary?.issues)}`;
    expect(summary?.metadata).toEqual([]);
    expect(text).not.toContain("SECRET REPORT BODY");
    expect(text).not.toContain('action: "resume"');
    const cancelled = summarize("await", { ...receipt, cancelled: true });
    expect(cancelled?.outcome).toBe("cancelled");
    expect(details(cancelled?.issues)).toContain("NOT stopped");
    const proxyCancelled = summarize("await", {
      ...receipt,
      cancelled: true,
      cancellationCleanup: "unconfirmed",
    });
    expect(proxyCancelled?.outcome).toBe("cancelled");
    const proxyDetails = details(proxyCancelled?.issues);
    expect(proxyDetails).toContain("Root completion-claim cleanup is unconfirmed");
    expect(proxyDetails).toContain("completion_claim_conflict");
    expect(proxyDetails).not.toContain("await the requested targets again");
  });

  it("does not turn a completed descendant into a missing target's completion", () => {
    const summary = summarize(
      "await",
      awaitReceipt([view({ id: "descendant", state: "completed", parentRunId: "target" })]),
      "settled",
      { runIds: ["target"] },
    );
    expect(summary?.subject).toBe("target");
    expect(summary?.counters).toContain("0/1 finished");
    expect(summary?.outcome).toBe("uncertain");
    expect(summary?.issues?.some((issue) => issue.code === "targets-omitted")).toBe(true);
  });

  it("marks omitted details as bounded rather than complete fleet counts", () => {
    const projected = makeCompactToolDetails({ action: "list", runs: [view()] });
    const summary = summarize("list", { ...projected, runCount: 20, contentOmitted: true });
    expect(summary?.counters?.join(" ")).toContain("1/20 shown");
    expect(summary?.outcome).toBe("uncertain");
    expect(summary?.issues?.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["evidence-omitted", "runs-omitted"]),
    );
    expect(details(summary?.issues)).toContain("subagent_status");
  });

  it("preserves workspace pagination, orphan recovery and exact test gates", () => {
    const summary = workspace("review", {
      workspaceId: "w",
      revisionId: "r",
      offset: 0,
      totalChars: 100,
      nextOffset: 50,
    });
    expect(summary?.issues?.map((issue) => issue.code)).toEqual([
      "read-revision",
      "prepare-revision",
      "test-preparation",
      "integrate-preparation",
    ]);
    expect(summary?.issues?.every((issue) => issue.severity === "info")).toBe(true);
    expect(summary?.outcome).toBe("success");
    const text = details(summary?.issues);
    for (const required of [
      "ALL pages",
      "revisionId=r",
      "offset=50",
      "prepare",
      "tests",
      "preparationId",
    ])
      expect(text).toContain(required);
    const list = workspace("list", { workspaceCount: 10, listedCount: 8, nextOffset: 8 });
    expect(details(list?.issues)).toContain("Do not auto-adopt or delete an orphan");
    expect(
      workspace("prepare", {
        workspaceId: "w",
        revisionId: "r",
        preparationId: "p",
        preparedCwd: "/combined",
      })?.issues?.[0]?.detail,
    ).toContain("/combined");
    const revised = workspace("revise", { workspaceId: "w", successorRunId: "successor" });
    expect(revised?.outcome).toBe("warning");
    expect(revised?.issues?.[0]?.severity).toBe("warning");
    expect(revised?.issues?.[0]?.detail).toContain("Await successor successor");
  });

  it("declines incomplete workspace receipts instead of inventing recovery IDs", () => {
    for (const details of [
      { operation: "review", workspaceId: "w", offset: 0, totalChars: 100 },
      { operation: "prepare", workspaceId: "w", preparedCwd: "/combined" },
      { operation: "integrate", workspaceId: "w", revisionId: "r" },
      { operation: "list", workspaceCount: 1, listedCount: 2 },
      { operation: "list", workspaceCount: 0, listedCount: 0, unavailableCount: 1 },
      { operation: "list", unavailableCount: 1 },
    ] as const)
      expect(workspace(details.operation, details)).toBeUndefined();
  });

  it("distinguishes proven report omissions from errors and unknown omissions", () => {
    const reports = makeCompactToolDetails({
      action: "list",
      runs: [view({ finalText: "report" })],
    });
    expect(summarize("list", reports)?.metadata).toEqual([]);
    expect(summarize("list", reports)?.issues).toEqual([]);
    for (const overrides of [{ error: "failure" }, { error: "failure", finalText: "report" }]) {
      const projected = makeCompactToolDetails({ action: "list", runs: [view(overrides)] });
      expect(
        summarize("list", projected)?.issues?.some((issue) => issue.code === "evidence-omitted"),
      ).toBe(true);
    }
    if (reports.action === "models") throw new Error("Expected run details");
    const { reportsOnlyOmitted, ...unknown } = reports;
    expect(reportsOnlyOmitted).toBe(true);
    expect(summarize("list", unknown)?.outcome).toBe("uncertain");
    expect(compactIssueSeverity(summarize("list", unknown)?.issues)).toBe("warning");
  });

  it("keeps distinct run and selection warning identities even when their text matches", () => {
    const warning = "Inspect the changed route";
    const projected = makeCompactToolDetails({
      action: "status",
      runs: ["agent-a", "agent-b"].map((id) =>
        view({ id, name: id, warning, selection: { ...view().selection, warning } }),
      ),
    });
    const issues = summarize("status", projected)?.issues?.filter((issue) =>
      issue.detail?.includes(warning),
    );
    expect(issues).toHaveLength(4);
    expect(new Set(issues?.map((issue) => issue.code)).size).toBe(4);
    for (const id of ["agent-a", "agent-b"]) {
      const owned = issues?.filter((issue) => issue.code.startsWith(`${id}:`));
      expect(owned).toHaveLength(2);
      expect(owned?.[0]?.message).not.toBe(owned?.[1]?.message);
    }
  });

  it("keeps system and child warning slots separate without matching their prose", () => {
    for (const source of ["child", "system"] as const) {
      const projected = makeCompactToolDetails({
        action: "status",
        runs: [
          view({
            warning: "Same warning words",
            warningSource: source,
            systemWarning: "Same warning words",
          }),
        ],
      });
      const summary = summarize("status", projected);
      expect(
        summary?.issues?.filter((issue) => issue.detail?.includes("Same warning words")),
      ).toHaveLength(source === "child" ? 2 : 1);
    }
    const inconsistent = summarize(
      "status",
      makeCompactToolDetails({
        action: "status",
        runs: [
          view({
            warning: "Latest system warning",
            warningSource: "system",
            systemWarning: "Older unmatched system warning",
          }),
        ],
      }),
    );
    expect(inconsistent?.issues?.filter((issue) => issue.severity === "warning")).toHaveLength(2);
  });

  it("retains child, system and selection warnings in every run projection", () => {
    for (const phase of ["running", "settled"] as const) {
      for (const extra of [
        {},
        { systemWarning: "System recovery" },
        { warningSource: undefined },
        { selection: { ...view().selection, warning: "Route recovery" } },
        { error: "Execution failed" },
      ]) {
        const run = view({ warning: "Child advisory", warningSource: "child", ...extra });
        const summary = summarize("await", awaitReceipt([run], { awaitedRunIds: [run.id] }), phase);
        const text = details(summary?.issues);
        expect(text).toContain("Child advisory");
        if ("systemWarning" in extra) expect(text).toContain(extra.systemWarning);
        if ("selection" in extra) expect(text).toContain("Route recovery");
        if ("error" in extra) expect(summary?.outcome).toBe("error");
        const projected = makeCompactToolDetails({ action: "status", runs: [run] });
        for (const action of ["status", "list"] as const) {
          const other = summarize(action, { ...projected, action }, phase);
          expect(details(other?.issues)).toContain("Child advisory");
        }
      }
    }
  });

  it("keeps running await counters stable while exposing new safety issues", () => {
    const snapshot = (reverse: boolean, warning?: string) => {
      const receipt = awaitReceipt(
        [
          view({
            id: "a",
            state: reverse ? "paused" : "running",
            currentTool: reverse ? "edit" : "read",
            progress: String(reverse),
            writeClaims: reverse ? ["a", "b"] : ["a"],
            warning,
          }),
          view({ id: "b", state: "completed" }),
        ],
        { awaitedRunIds: ["a", "b"] },
      );
      return reverse ? { ...receipt, cards: [...receipt.cards].reverse() } : receipt;
    };
    const first = summarize("await", snapshot(false), "running");
    const next = summarize("await", snapshot(true, "new warning"), "running");
    expect(first?.counters).toEqual(["1/2 finished"]);
    expect(first?.metadata).toEqual([]);
    expect(next?.counters).toEqual(first?.counters);
    expect(details(next?.issues)).toContain("new warning");
    const completed = snapshot(false);
    const finalProgress = summarize(
      "await",
      { ...completed, cards: completed.cards.map((card) => ({ ...card, state: "completed" })) },
      "running",
    );
    expect(finalProgress?.subject).toBe(first?.subject);
    expect(finalProgress?.counters).toEqual(["2/2 finished"]);
    expect(summarize("await", { ...snapshot(false), timedOut: true })?.outcome).toBe("warning");
    expect(summarize("await", { ...snapshot(false), cancelled: true })?.outcome).toBe("cancelled");
    expect(
      summarize("status", makeCompactToolDetails({ action: "status", runs: [] }), "running", {
        runIds: ["a", "b", "c"],
      })?.counters,
    ).toEqual(["3 targets"]);
  });

  it("only cautions about report integration for isolated writers", () => {
    for (const overrides of [
      { writeIntent: "read-only" as const },
      { writeIntent: "writer" as const, writerWorkspaceMode: "shared-checkout" as const },
      { writeIntent: "writer" as const, writerWorkspaceMode: "worktree" as const },
    ]) {
      const projected = makeCompactToolDetails({
        action: "status",
        runs: [view({ ...overrides, state: "reported", finalText: "report" })],
      });
      const summary = summarize("status", projected);
      expect(summary?.metadata).toEqual([]);
      expect(summary?.issues?.some((issue) => issue.code.endsWith(":workspace-approval"))).toBe(
        overrides.writerWorkspaceMode === "worktree",
      );
    }
    const details = makeCompactToolDetails({
      action: "status",
      runs: [view({ state: "reported" })],
    });
    expect(summarize("status", details)?.metadata).not.toContain("1 report");
  });

  it("keeps successful integrate facts and empty lists quiet without weakening nonempty recovery", () => {
    const integrated = workspace("integrate", {
      workspaceId: "w",
      revisionId: "r",
      preparationId: "p",
    });
    expect(integrated?.issues).toEqual([]);
    expect(integrated?.outcome).toBe("success");
    expect(integrated?.counters).toEqual(["integrated"]);
    expect(integrated?.metadata).toEqual([]);
    expect(workspace("list", { workspaceCount: 0, listedCount: 0 })?.issues).toEqual([]);
    expect(workspace("list", {})?.issues).toHaveLength(1);
    const paged = workspace("list", { workspaceCount: 2, listedCount: 1, nextOffset: 1 });
    expect(details(paged?.issues)).toContain("offset=1");
  });

  it("counts static mixed profile eligibility without warning for usable alternatives", () => {
    const candidate = {
      host: "local",
      runtime: "pi",
      model: "provider/model",
      effort: "default",
      context: "fresh",
      writeIntent: "read-only",
      openaiFastMode: false,
      closeOnReport: true,
      status: "eligible",
      reason: "Static eligibility",
    };
    const profile = {
      id: "scout",
      description: "Scout",
      source: "builtin",
      isDefault: false,
      defaultContext: "fresh",
      defaultWriteIntent: "read-only",
      candidates: [
        candidate,
        { ...candidate, status: "skipped", reason: "Unavailable alternative" },
      ],
    };
    const discovery = (profiles: object[], extra = {}) =>
      summarize("models", {
        version: 2,
        action: "models",
        profiles,
        fallbackProfile: "generalist",
        ...extra,
      });
    const clean = discovery([profile, { ...profile, id: "worker", candidates: [] }]);
    expect(clean?.outcome).toBe("success");
    expect(clean?.issues).toEqual([]);
    expect(clean?.counters).toEqual(["1 statically eligible, 1 disabled profiles"]);
    for (const unavailable of [
      { ...profile, candidates: [{ ...candidate, status: "skipped" }] },
      { ...profile, source: "global-invalid", candidates: [] },
      { ...profile, source: "project-invalid" },
    ]) {
      const summary = discovery([unavailable]);
      expect(summary?.outcome).toBe("warning");
      expect(summary?.issues?.map((issue) => issue.severity)).toEqual(["warning"]);
      expect(summary?.counters?.join(" ")).toContain("1 unavailable profiles");
      expect(summary?.counters?.join(" ")).toContain("0 statically eligible");
      expect(summary?.counters).not.toContain("1 eligible profiles");
    }
    expect(discovery([{ ...profile, candidates: [] }])?.counters).toEqual([
      "0 statically eligible, 1 disabled profiles",
    ]);
    expect(
      summarize(
        "models",
        { version: 2, action: "models", profiles: [profile], fallbackProfile: "generalist" },
        "settled",
        { profile: "scout" },
      )?.subject,
    ).toBe("scout");
    expect(discovery([profile], { contentOmitted: true })?.outcome).toBe("uncertain");
    expect(discovery([{ ...profile, source: "unknown" }])).toBeUndefined();
  });

  it("keeps clean terminal static skip history expanded-only and warns otherwise", () => {
    const skipped = {
      candidate: "alternative",
      code: "pi_model_unknown",
      reason: "Historical missing model",
    };
    const selection = { ...view().selection, skippedCandidates: [skipped] };
    const warns = (issues: readonly CompactIssue[] | undefined) =>
      issues?.some(
        (issue) => issue.severity === "warning" && issue.detail?.includes(skipped.reason),
      );
    for (const state of ["completed", "reported"] as const) {
      const projected = makeCompactToolDetails({
        action: "status",
        runs: [view({ state, selection })],
      });
      const summary = summarize("status", projected);
      expect(summary?.outcome).toBe("success");
      expect(summary?.issues?.map((issue) => issue.severity)).toEqual(["info"]);
      expect(details(summary?.issues)).toContain(skipped.reason);
      expect(summary?.metadata).toEqual([]);
      expect(summarize("status", projected, "running")?.metadata).toEqual([]);
      for (const patch of [
        { warning: "Herdr to local fallback" },
        { selection: { ...selection, warning: "Explicit selection warning" } },
        {
          selection: {
            ...selection,
            skippedCandidates: [{ ...skipped, code: "start_failed_before_prompt" }],
          },
        },
        { state: "failed" as const },
        { error: "Failure evidence" },
        { writeAdmissionPaused: true },
      ]) {
        const unsafe = makeCompactToolDetails({
          action: "status",
          runs: [view({ state, selection, ...patch })],
        });
        expect(warns(summarize("status", unsafe)?.issues)).toBe(true);
      }
      expect(warns(summarize("status", { ...projected, contentOmitted: true })?.issues)).toBe(true);
    }
  });

  it("keeps claim operations and failed launch recovery compact", () => {
    expect(
      summarize("claims", makeCompactToolDetails({ action: "claims", runs: [] }))?.outcome,
    ).toBe("success");
    const failed = summarize("start", {
      version: 2,
      action: "start",
      startEntries: [{ ...pending, status: "failed", routeStatus: "unavailable" }],
      startFailures: [{ index: 0, message: "Cleanup not confirmed" }],
    });
    expect(failed?.outcome).toBe("error");
    expect(failed?.issues?.map((issue) => issue.severity)).toEqual(["error", "warning"]);
  });
});
