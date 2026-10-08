import { compactIssueSeverity, type CompactIssue } from "pi-code-previews";
import { issueMessageStyleProblems, renderContextFixture } from "pi-code-previews/testing";
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
/** Everything an issue retains: a quoted line may be the message alone. */
const evidence = (issues: readonly CompactIssue[] | undefined) =>
  `${messages(issues)}\n${details(issues)}`;

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

/** A status receipt over run views with these overrides. */
const statusOf = (...runs: ReadonlyArray<Partial<SubagentRunView>>) =>
  makeCompactToolDetails({ action: "status", runs: runs.map((run) => view(run)) });

/** An await receipt over status-projected cards that states target scope only through `extra`. */
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

describe("subagent compact semantic policy", () => {
  it("treats pending and unresolved steering as delivery uncertainty, not worker failure", () => {
    for (const steeringDelivery of ["pending", "unresolved"] as const) {
      for (const state of ["running", "completed"] as const) {
        const run = view({ steeringDelivery, state });
        const status = statusOf(run);
        const summary = summarize("status", status);
        expect(summary?.outcome).toBe("uncertain");
        expect(compactIssueSeverity(summary?.issues)).toBe("warning");
        expect(details(summary?.issues)).toContain(`steeringDelivery=${steeringDelivery}`);
        expect(details(summary?.issues)).toContain("Do not resend");
        expect(messages(summary?.issues)).not.toContain("failed");
      }
    }
    for (const steeringDelivery of ["confirmed", "not-sent", "report-unconfirmed"] as const) {
      const summary = summarize("status", statusOf({ steeringDelivery }));
      expect(summary?.outcome).toBe(steeringDelivery === "confirmed" ? "success" : "warning");
      expect(details(summary?.issues)).toContain(`steeringDelivery=${steeringDelivery}`);
    }
  });

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
      statusOf({ id: "one", warning: "Review external ownership before retrying." }),
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
    // Counters use the run rows' state words.
    expect(summary?.counters?.[0]).toContain("1 running");
    expect(summary?.counters?.[0]).toContain("1 finished");
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
      // Before a receipt names the run, the heading has no subject rather than its ID.
      expect(summary?.subject).toBe(phase === "pending" ? "" : "Worker");
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
      // The successor's name heads the row; a name that is only an ID never does.
      expect(summary?.subject).toBe(name === "Retry worker" ? name : "");
      expect(summary?.metadata).not.toContain("successor-2");
      expect(summary?.metadata).not.toContain("source-1");
      expect(summary?.issues).toEqual([]);
    }
  });

  it("does not present an incomplete or different target as a single named run", () => {
    const details = statusOf({ id: "visible", name: "Visible", state: "running" });
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
    const summary = summarize(
      "status",
      statusOf({ state: "running", writeIntent: "writer", writeClaims: ["src/a.ts"] }),
    );
    expect(summary?.outcome).toBe("success");
    // A sole target shows its decoded state, never the result's text.
    expect(summary?.counters).toContain("running");
    expect(summary?.metadata).toEqual([]);
  });

  it("reads requested targets as execution does: trimmed and each once", () => {
    const receipt = awaitReceipt([view({ state: "completed" })], { awaitedRunIds: ["agent-1"] });
    for (const runIds of [["agent-1", "agent-1"], [" agent-1 "]]) {
      const awaited = summarize("await", receipt, "settled", { runIds });
      expect(awaited?.subject).toBe("auth-review");
      expect(awaited?.counters).toContain("finished");
      expect(awaited?.outcome).toBe("success");
      expect(awaited?.issues?.map((issue) => issue.code)).not.toContain("targets-omitted");
      expect(summarize("status", statusOf({}), "settled", { runIds })?.subject).toBe("auth-review");
    }
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

  it("keeps attention visible in the worker's own words, never procedures or IDs", () => {
    for (const [overrides, quoted] of [
      [
        {
          state: "waiting_for_parent" as const,
          question: { message: "May I edit another file?", requestId: "q-1" },
        },
        "May I edit another file?",
      ],
      [{ state: "paused" as const }, undefined],
      [{ state: "failed" as const, error: "Cleanup uncertain" }, "Cleanup uncertain"],
      [
        { writeIntent: "writer" as const, writeClaims: ["src/a.ts"], writeAdmissionPaused: true },
        undefined,
      ],
      [{ warning: "Fallback changed runtime" }, "Fallback changed runtime"],
    ] as const) {
      const card = view({ id: "PRIVATE-RUN", ...overrides });
      const projected = statusOf(card);
      for (const phase of ["running", "settled"] as const) {
        const issues = summarize("status", projected, phase)?.issues;
        expect(compactIssueSeverity(issues)).toBeDefined();
        // The worker's own words are the attention; procedures and IDs are not.
        if (quoted) expect(messages(issues)).toContain(quoted);
        expect(messages(issues)).not.toMatch(/PRIVATE-RUN|subagent_/);
        for (const issue of issues ?? [])
          expect(
            issueMessageStyleProblems(issue.message, { forbidden: ["PRIVATE-RUN"] }),
            issue.message,
          ).toEqual([]);
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
        const word = action === "send" ? "sent" : "replied";
        // A zero beside a failure count says nothing; accepted operations are counted.
        if (accepted > 0) expect(receipt).toContain(`${accepted} ${word}`);
        else expect(receipt).not.toContain(word);
        expect(receipt).toContain("1 failed");
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

  it.each(["send", "reply", "resume", "stop"] as const)(
    "keeps uncertain %s failures distinct from definite errors, even with Pi isError",
    (action) => {
      for (const code of ["claude_steering_outcome_uncertain", "stop_cleanup_unconfirmed"]) {
        for (const confirmed of [0, 1]) {
          const projected = makeCompactToolDetails({
            action,
            runs: confirmed ? [view({ id: "confirmed" })] : [],
            actionFailures: [{ id: "uncertain", code, message: "Native evidence. Do not resend." }],
          });
          const tool = action === "resume" || action === "stop" ? "lifecycle" : action;
          const summary = summarize(tool, projected, "settled", { action }, true);
          expect(summary?.outcome).toBe("uncertain");
          expect(compactIssueSeverity(summary?.issues)).toBe("warning");
          expect(details(summary?.issues)).toContain(code);
          expect(details(summary?.issues)).toContain("Do not resend");
          expect(messages(summary?.issues)).not.toContain("Do not resend");
          if (action === "send" || action === "reply")
            expect(summary?.counters?.join(" ")).toContain(
              confirmed
                ? `1 ${action === "send" ? "sent" : "replied"}, 1 unconfirmed`
                : "1 unconfirmed",
            );
          const mixed = makeCompactToolDetails({
            action,
            runs: [],
            actionFailures: [
              { id: "uncertain", code, message: "Native evidence" },
              { id: "definite", code: "not_running", message: "Worker is not running" },
            ],
          });
          const errors = summarize(tool, mixed, "settled", { action }, true);
          expect(errors?.outcome).toBe("error");
          expect(compactIssueSeverity(errors?.issues)).toBe("error");
        }
      }
    },
  );

  it("keeps typed pending delivery an uncertain warning with distinct counters", () => {
    const pendingFailure = {
      id: "pending-run",
      code: "steer_outcome_uncertain",
      message: "Guidance may have been sent; acknowledgement is pending. Do not resend.",
      pendingDelivery: true as const,
    };
    const unflagged = {
      id: "unflagged-run",
      code: pendingFailure.code,
      message: pendingFailure.message,
    };
    const definite = { id: "definite-run", code: "not_running", message: "Worker is not running" };
    for (const [confirmed, failures, outcome, parts] of [
      [0, [pendingFailure], "uncertain", ["1 awaiting confirmation"]],
      [1, [pendingFailure], "uncertain", ["1 sent", "1 awaiting confirmation"]],
      [0, [pendingFailure, definite], "error", ["1 awaiting confirmation", "1 failed"]],
      [1, [pendingFailure, unflagged], "uncertain", ["1 awaiting confirmation", "1 unconfirmed"]],
    ] as const) {
      const projected = makeCompactToolDetails({
        action: "send",
        runs: confirmed ? [view({ id: "confirmed-run" })] : [],
        actionFailures: failures,
      });
      const summary = summarize("send", projected);
      expect(summary?.outcome).toBe(outcome);
      for (const part of parts) expect(summary?.counters?.join(" ")).toContain(part);
      const pendingIssues = (summary?.issues ?? []).filter((issue) =>
        issue.code.startsWith("run:pending-run:"),
      );
      // Pending is a warning, never an error; identity and code stay expanded-only.
      expect(pendingIssues.map((issue) => issue.severity)).toEqual(["warning", "info"]);
      expect(messages(pendingIssues)).not.toMatch(/pending-run|steer_outcome_uncertain|failed/);
      expect(details(pendingIssues)).toContain("steer_outcome_uncertain");
      expect(details(pendingIssues)).toContain("Do not resend");
      expect(details(pendingIssues)).toContain("stop remains available");
      if (outcome !== "error") expect(compactIssueSeverity(summary?.issues)).toBe("warning");
    }
    // A flag decoded on another action keeps its code-based uncertainty.
    const reply = makeCompactToolDetails({
      action: "reply",
      runs: [],
      actionFailures: [{ ...unflagged, code: "steer_outcome_uncertain" }],
    });
    const forged = summarize("reply", {
      ...reply,
      actionFailures: [{ ...pendingFailure, id: "unflagged-run" }],
    });
    expect(forged?.counters?.join(" ")).toContain("1 unconfirmed");
    expect(forged?.counters?.join(" ")).not.toContain("awaiting confirmation");
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
          makeCompactToolDetails({
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

  it("accepts only matching typed failure details when Pi reports an error", () => {
    const failedWorker = statusOf({ state: "failed" });
    expect(summarize("status", failedWorker, "settled", {}, true)).toBeUndefined();
    const missing = makeCompactToolDetails({
      action: "status",
      runs: [],
      actionFailures: [{ id: "missing", message: "Worker not found" }],
    });
    expect(summarize("status", missing, "settled", {}, true)?.outcome).toBe("error");
    expect(summarize("send", missing, "settled", {}, true)).toBeUndefined();
    expect(
      summarize(
        "workspace",
        { version: 1, action: "workspace", operation: "list", workspaceCount: 0 },
        "settled",
        { action: "list" },
        true,
      ),
    ).toBeUndefined();
    for (const code of ["start_outcome_uncertain", "start_cleanup_unconfirmed"]) {
      const launch = {
        version: 2,
        action: "start",
        startEntries: [{ ...pending, status: "failed", routeStatus: "unavailable" }],
        startFailures: [{ index: 0, code, message: "Unconfirmed launch evidence" }],
      };
      const summary = summarize("start", launch, "settled", {}, true);
      expect(summary?.outcome).toBe("uncertain");
      expect(compactIssueSeverity(summary?.issues)).toBe("warning");
      expect(details(summary?.issues)).toContain(code);
      expect(details(summary?.issues)).toContain("Do not retry");
    }
  });

  it("keeps historical launch failures conservative when admission receipts are missing", () => {
    for (const code of ["unknown_failure", "automatic_routing_low_confidence"]) {
      const message = "Historical launch failure";
      const summary = summarize("start", {
        version: 2,
        action: "start",
        startEntries: [
          { ...pending, profile: "generalist", status: "failed", routeStatus: "unavailable" },
        ],
        startFailures: [{ index: 0, code, message }],
      });
      expect(summary?.outcome).toBe("error");
      expect(details(summary?.issues)).toContain(message);
      expect(
        (summary?.issues ?? []).flatMap((issue) => issueMessageStyleProblems(issue.message)),
      ).toEqual([]);
      expect(summary?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "launch:0:recovery-unknown", severity: "warning" }),
        ]),
      );
    }
  });

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
    const details = statusOf({ state });
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
    // Cleanup and the retry it allows share one expanded-only line.
    expect(summary?.issues?.map((issue) => issue.severity)).toEqual(["error", "info"]);
    expect(details(summary?.issues)).toContain('action: "retry"');
  });

  it("matches claims operations to the claims detail family", () => {
    const details = makeCompactToolDetails({
      action: "claims",
      runs: [view({ writeIntent: "writer", writeClaims: ["src/a.ts"] })],
    });
    const summary = summarize("claims", details, "settled", { action: "list" });
    // The operation reads as a word, never the raw argument token.
    expect(summary?.action).toBeTruthy();
    expect(summary?.action).not.toBe("list");
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
      const projected = statusOf({
        state: "paused",
        writeIntent: "writer",
        writeAdmissionPaused: true,
        ...(offender && { writeViolationOffender: true }),
        writeClaims: ["src/a.ts"],
        writeAudit: { observedFileWrites: [], violations: [], bashWriteHints: 0 },
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
    // An unnamed target stays unnamed: its ID is expanded-only detail.
    expect(summary?.subject).toBe("");
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
    // A list never carries reports, so any omission there is one routine note.
    expect(summarize("list", unknown)?.outcome).toBe("success");
    expect(summarize("list", unknown)?.issues?.map((issue) => issue.severity)).toEqual(["info"]);
    // A status view that loses evidence cannot confirm its targets.
    const status = statusOf({});
    const omittedStatus = { ...status, contentOmitted: true };
    expect(summarize("status", omittedStatus)?.outcome).toBe("uncertain");
    expect(compactIssueSeverity(summarize("status", omittedStatus)?.issues)).toBe("warning");
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
      const projected = statusOf({
        warning: "Same warning words",
        warningSource: source,
        systemWarning: "Same warning words",
      });
      const summary = summarize("status", projected);
      expect(
        summary?.issues?.filter((issue) => evidence([issue]).includes("Same warning words")),
      ).toHaveLength(source === "child" ? 2 : 1);
    }
    const inconsistent = summarize(
      "status",
      statusOf({
        warning: "Latest system warning",
        warningSource: "system",
        systemWarning: "Older unmatched system warning",
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
        const text = evidence(summary?.issues);
        expect(text).toContain("Child advisory");
        if ("systemWarning" in extra) expect(text).toContain(extra.systemWarning);
        if ("selection" in extra) expect(text).toContain("Route recovery");
        if ("error" in extra) expect(summary?.outcome).toBe("error");
        const projected = statusOf(run);
        for (const action of ["status", "list"] as const) {
          const other = summarize(action, { ...projected, action }, phase);
          expect(evidence(other?.issues)).toContain("Child advisory");
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
    expect(evidence(next?.issues)).toContain("new warning");
    const completed = snapshot(false);
    const finalProgress = summarize(
      "await",
      { ...completed, cards: completed.cards.map((card) => ({ ...card, state: "completed" })) },
      "running",
    );
    expect(finalProgress?.subject).toBe(first?.subject);
    expect(finalProgress?.counters).toEqual(["2/2 finished"]);
    expect(summarize("await", { ...snapshot(false), cancelled: true })?.outcome).toBe("cancelled");
    expect(
      summarize("status", statusOf(), "running", {
        runIds: ["a", "b", "c"],
      })?.counters?.join(" "),
    ).toContain("3");
  });

  it("marks isolated writers' reports as ready for review without warning", () => {
    for (const overrides of [
      { writeIntent: "read-only" as const },
      { writeIntent: "writer" as const, writerWorkspaceMode: "shared-checkout" as const },
      { writeIntent: "writer" as const, writerWorkspaceMode: "worktree" as const },
    ]) {
      const projected = statusOf({ ...overrides, state: "completed", finalText: "report" });
      const summary = summarize("status", projected);
      const isolated = overrides.writerWorkspaceMode === "worktree";
      // Review is the normal next step: a heading label and expanded note, never a warning.
      expect(summary?.outcome).toBe("success");
      // The label joins the counter, with the bare counter as the narrow-row fallback.
      expect(summary?.counters).toHaveLength(isolated ? 2 : 1);
      if (isolated) expect(summary?.counters?.[0]?.startsWith(summary.counters[1]!)).toBe(true);
      expect(
        summary?.issues?.find((issue) => issue.code.endsWith(":workspace-approval"))?.severity,
      ).toBe(isolated ? "info" : undefined);
    }
    const details = statusOf({ state: "completed" });
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
    expect(clean?.counters).toHaveLength(1);
    expect(clean?.counters?.[0]).toContain("1 statically eligible");
    expect(clean?.counters?.[0]).toContain("1 disabled");
    for (const unavailable of [
      { ...profile, candidates: [{ ...candidate, status: "skipped" }] },
      { ...profile, source: "global-invalid", candidates: [] },
      { ...profile, source: "project-invalid" },
    ]) {
      const summary = discovery([unavailable]);
      expect(summary?.outcome).toBe("warning");
      expect(summary?.issues?.map((issue) => issue.severity)).toEqual(["warning"]);
      expect(summary?.counters?.join(" ")).toContain("1 unavailable");
      expect(summary?.counters?.join(" ")).toContain("0 statically eligible");
      expect(summary?.counters?.join(" ")).not.toContain("1 eligible");
    }
    expect(discovery([{ ...profile, candidates: [] }])?.counters).toEqual([
      "0 statically eligible, 1 disabled profile",
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
    for (const state of ["completed"] as const) {
      const projected = statusOf({ state, selection });
      const summary = summarize("status", projected);
      expect(summary?.outcome).toBe("success");
      expect(summary?.issues?.map((issue) => issue.severity)).toEqual(["info"]);
      expect(details(summary?.issues)).toContain(skipped.reason);
      expect(summary?.metadata).toEqual([]);
      expect(summarize("status", projected, "running")?.metadata).toEqual([]);
      for (const patch of [
        { warning: "Declared local candidate fallback" },
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
        const unsafe = statusOf({ state, selection, ...patch });
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

  it("writes every issue message in the shared style, without run IDs", () => {
    const id = "run-7f3a";
    const audit = {
      observedFileWrites: ["src/b.ts"],
      violations: [{ path: "src/b.ts", toolName: "edit", observedAt: 2 }],
      bashWriteHints: 0,
    };
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
      ...(["running", "paused", "stopped"] as const).map((state) => ({
        state,
        writeIntent: "writer" as const,
        writeClaims: ["src/a.ts"],
        writeAdmissionPaused: true,
        writeViolationOffender: true,
        writeAudit: audit,
      })),
      { writeIntent: "writer", writeClaims: ["src/a.ts"], writeAdmissionPaused: true },
      { writeIntent: "writer", writeClaims: ["src/a.ts"], writeAudit: audit, state: "completed" },
      { warning: "Could not run the integration tests: docker is not available" },
      { warning: "Context window 91% full", warningSource: "system", systemWarning: "Other" },
      { selection: { ...view().selection, warning: "Protocol 21 is unsupported. Fell back." } },
      {
        selection: {
          ...view().selection,
          skippedCandidates: [{ candidate: "alt", code: "pi_model_unknown", reason: "Missing" }],
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
    ];
    const issues = runs.flatMap((overrides) => {
      const run = view({ id, ...overrides });
      return [
        ...(summarize("status", statusOf(run))?.issues ?? []),
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
        issueMessageStyleProblems(issue.message, { forbidden: [id], maxLength: 160 }),
        issue.message,
      ).toEqual([]);
  });
  it("keeps failed actions and rejected calls in people's terms, with service text expanded", () => {
    const id = "agent-ns-42";
    const serviceText = (code: string) =>
      `Subagent ${id} failed [${code}]; use subagent_status({ runIds: ["${id}"] }) first.`;
    const codes = [
      "run_waiting_for_parent",
      "parent_question_missing",
      "retry_route_exhausted",
      "write_claim_change_not_waiting",
      "SubagentNotFoundError",
      "report_delivery_backlog",
      "an_unrecognised_code",
      "reply_outcome_uncertain",
    ];
    for (const code of codes)
      for (const [tool, action] of [
        ["reply", "reply"],
        ["lifecycle", "retry"],
        ["claims", "grant"],
      ] as const) {
        const detailsAction = tool === "lifecycle" ? action : tool;
        const summary = summarize(
          tool,
          makeCompactToolDetails({
            action: detailsAction,
            runs: [],
            actionFailures: [{ id, code, message: serviceText(code) }],
          }),
          "settled",
          { action, runIds: [id] },
          true,
        );
        expect(summary?.subject).not.toContain(id);
        const failure = summary?.issues?.find((issue) => issue.code.endsWith(":action-failed"));
        expect(failure?.detail).toContain(serviceText(code));
        for (const issue of summary?.issues ?? [])
          if (issue.severity !== "info")
            expect(
              issueMessageStyleProblems(issue.message, { forbidden: [id] }),
              issue.message,
            ).toEqual([]);
      }
    // A visible card names the failed target instead of a generic subject.
    const named = summarize(
      "send",
      makeCompactToolDetails({
        action: "send",
        runs: [view({ id: "other", name: "docs-sweep" }), view({ id, name: "auth-review" })],
        actionFailures: [{ id, code: "run_waiting_for_parent", message: serviceText("x") }],
      }),
    );
    expect(messages(named?.issues)).toContain("auth-review");
    // Calls rejected before any receipt keep their heading and explain themselves.
    const provider = (tool: string) => createSubagentCompactSummary(`subagent_${tool}`);
    for (const [tool, args, text] of [
      [
        "lifecycle",
        { action: "stop", runIds: [id], message: "Wrap up" },
        'subagent_lifecycle message is valid only when action="resume".',
      ],
      ["workspace", { action: "prepare", workspaceId: "ws-1" }, "The revision no longer matches."],
      ["send", { runIds: [id], message: "x" }, `Subagent ${id} rejected send({ runId: "${id}" }).`],
    ] as const) {
      const summary = provider(tool)({
        phase: "settled",
        args,
        result: { content: [{ type: "text", text }], details: {} },
        context: renderContextFixture({ isError: true }),
      });
      expect(summary?.outcome).toBe("error");
      expect(summary?.subject).not.toContain(id);
      expect(summary?.subject).not.toContain("ws-1");
      const [issue] = summary?.issues ?? [];
      expect(issue?.severity).toBe("error");
      expect(issueMessageStyleProblems(issue?.message ?? "", { forbidden: [id] })).toEqual([]);
      expect(`${issue?.message}\n${issue?.detail ?? ""}`).toContain(text.replace(/\.$/u, ""));
    }
  });
  it("treats requested results and routine history as routine, not warnings", () => {
    // A pause the call asked for is its result.
    const interrupted = summarize(
      "lifecycle",
      makeCompactToolDetails({ action: "interrupt", runs: [view({ state: "paused" })] }),
      "settled",
      { action: "interrupt", runIds: ["agent-1"] },
    );
    expect(interrupted?.outcome).toBe("success");
    expect(interrupted?.issues?.map((issue) => issue.severity)).toEqual(["info"]);
    // A retry moving past its failed option is the expected step, explained in people's terms.
    const key =
      "local/pi/anthropic/claude-opus-4-7:high:fresh:read-only:openaiFastMode=false:closeOnReport=true";
    const retried = summarize(
      "lifecycle",
      makeCompactToolDetails({
        action: "retry",
        runs: [
          view({
            id: "successor",
            selection: {
              ...view().selection,
              candidateIndex: 1,
              skippedCandidates: [
                {
                  candidate: key,
                  code: "previous_run_failed",
                  reason: "Candidate 1 failed in source: Error: 429 Too Many Requests",
                },
              ],
            },
          }),
        ],
      }),
      "settled",
      { action: "retry", runIds: ["source"] },
    );
    expect(retried?.outcome).toBe("success");
    const skipped = retried?.issues?.find((issue) => issue.code.endsWith("selection-skipped"));
    expect(skipped?.severity).toBe("info");
    expect(skipped?.detail).not.toContain("openaiFastMode=");
    expect(skipped?.detail).not.toContain("source");
    // A list leaves report text out on purpose: one note for the whole list, not one per run.
    const listed = summarize(
      "list",
      makeCompactToolDetails({
        action: "list",
        runs: [
          view({ id: "a", state: "completed", finalText: "report" }),
          view({ id: "b", state: "completed", finalText: "report" }),
          view({ id: "c", state: "failed", error: "Rate limit exceeded" }),
        ],
      }),
    );
    const omissions = (listed?.issues ?? []).filter((issue) =>
      issue.code.endsWith("evidence-omitted"),
    );
    expect(omissions.map((issue) => issue.severity)).toEqual(["info"]);
  });

  it("counts failed and stopped await targets apart from finished ones", () => {
    const summary = summarize(
      "await",
      awaitReceipt([
        view({ id: "a", state: "completed" }),
        view({ id: "b", state: "failed" }),
        view({ id: "c", state: "stopped" }),
      ]),
      "settled",
      { runIds: ["a", "b", "c"] },
    );
    const counter = summary?.counters?.join(" ") ?? "";
    expect(counter).toContain("1/3 finished");
    expect(counter).toContain("1 failed");
    expect(counter).toContain("1 stopped");
  });
});
