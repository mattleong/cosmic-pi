import { describe, expect, it } from "vitest";
import type { FailedStartRecovery, SubagentRunView } from "../../src/run/model.ts";
import type { SubagentRunObservation } from "../../src/run/service.ts";
import {
  awaitContract,
  cancelledAwaitContract,
  lifecycleContract,
  startContract,
  statusContract,
} from "../../src/tools/contract.ts";
import {
  decodeSubagentContract,
  type SubagentContract,
  type SubagentContractTool,
} from "../../src/tools/contract-schema.ts";
import { containedWriter, view } from "../fixtures/run-view.ts";

/** Every builder result must survive the strict public decoder unchanged. */
const decoded = <Tool extends SubagentContractTool>(
  tool: Tool,
  contract: SubagentContract<Tool>,
): SubagentContract<Tool> => {
  const result = decodeSubagentContract(tool, contract);
  expect(result).toEqual(contract);
  return result!;
};

const receipt = (id: string) => ({ id, generation: 1, claimToken: `claim-${id}` });
const finished = (id: string, overrides: Partial<SubagentRunView> = {}) =>
  view({ id, name: id, state: "completed", reportGeneration: 1, ...overrides });
const recovery = (runId: string, overrides: Partial<FailedStartRecovery> = {}) =>
  ({
    runId,
    cleanupDisposition: "confirmed",
    retryDisposition: "eligible",
    remainingCandidateCount: 1,
    hasRemainingCandidate: true,
    ...overrides,
  }) satisfies FailedStartRecovery;

describe("start contract", () => {
  it("keeps request order, full started IDs, and admitted-run recovery for a partial batch", () => {
    const longId = `run-${"x".repeat(300)}`;
    const contract = decoded(
      "subagent_start",
      startContract(
        [
          { task: "a", name: "first", profile: "worker" },
          { task: "b", name: "second", profile: "reviewer" },
          { task: "c" },
        ],
        [
          {
            index: 1,
            failure: {
              index: 1,
              name: "second",
              message: "Backend exited before readiness.",
              code: "SubagentProcessError",
              admittedRun: recovery("run-2"),
            },
            resolvedRoute: {
              profile: "reviewer",
              host: "local",
              runtime: "claude",
              model: "opus",
              effort: "high",
              openaiFastMode: false,
            },
          },
          { index: 0, run: view({ id: longId, name: "first", profile: "worker" }) },
          {
            index: 2,
            failure: { index: 2, message: "Spawn may have run.", code: "spawn_outcome_uncertain" },
          },
        ],
      ),
    );
    expect(contract.outcome).toBe("partial");
    expect(contract.launches.map((launch) => [launch.index, launch.status])).toEqual([
      [0, "started"],
      [1, "failed"],
      [2, "failed"],
    ]);
    expect(contract.launches[0]).toMatchObject({ runId: longId, profile: "worker" });
    expect(contract.launches[1]).toMatchObject({
      name: "second",
      profile: "reviewer",
      failure: { disposition: "failed", code: "SubagentProcessError" },
      admittedRun: {
        runId: "run-2",
        cleanup: "confirmed",
        disposition: "eligible",
        remainingCandidateCount: 1,
      },
    });
    expect(contract.launches[2]).toMatchObject({ failure: { disposition: "unconfirmed" } });
    expect(contract.launches[2]).not.toHaveProperty("admittedRun");
  });

  it("preserves unconfirmed disposition when no launch receipt was observed", () => {
    const contract = decoded("subagent_start", startContract([{ task: "a" }, { task: "b" }], []));
    expect(contract.outcome).toBe("failed");
    expect(contract.launches.map((launch) => launch.status)).toEqual(["failed", "failed"]);
    for (const launch of contract.launches)
      expect(launch).toMatchObject({ failure: { disposition: "unconfirmed" } });
  });
});

describe("report disposition", () => {
  const report = (observation: SubagentRunObservation, rendered: ReadonlyArray<string> = []) =>
    decoded(
      "subagent_status",
      statusContract({
        observations: [observation],
        fullyRenderedIds: new Set(rendered),
        missingRunIds: [],
      }),
    ).targets[0]!.report;

  it("delivers text only for a fully rendered owned receipt", () => {
    const run = finished("a", { finalText: "Done.", reportStatus: "available" });
    expect(report({ run, completionReceipt: receipt("a") }, ["a"])).toEqual({
      status: "delivered",
      text: "Done.",
    });
    // Owned but truncated in the visible result: deferred, never silently consumed.
    expect(report({ run, completionReceipt: receipt("a") })).toEqual({ status: "deferred" });
    // Rendered without ownership never delivers.
    expect(report({ run: finished("a", { finalText: "Done." }) }, ["a"])).toEqual({
      status: "unknown",
    });
  });

  it("names every omitted report instead of dropping it", () => {
    expect(report({ run: finished("a", { reportStatus: "claimed" }) }, ["a"])).toEqual({
      status: "claimed",
    });
    expect(report({ run: finished("a", { reportStatus: "delivered" }) }, ["a"])).toEqual({
      status: "already_delivered",
    });
    expect(report({ run: finished("a", { reportStatus: "available" }) }, ["a"])).toEqual({
      status: "deferred",
    });
    expect(
      report({ run: finished("a", { reportStatus: "missing" }), completionReceipt: receipt("a") }, [
        "a",
      ]),
    ).toEqual({ status: "missing" });
    expect(report({ run: view({ id: "a", finalText: "partial" }) }, ["a"])).toEqual({
      status: "not_finished",
    });
  });

  it("classifies a fully returned controls-only report as missing, not deferred", () => {
    const run = finished("a", { finalText: "\u001b[0m", reportStatus: "available" });
    expect(report({ run, completionReceipt: receipt("a") }, ["a"])).toEqual({ status: "missing" });
  });

  it("returns an opted-in delivered read-back without a receipt", () => {
    const run = finished("a", { reportStatus: "delivered", finalText: "Earlier report." });
    expect(report({ run })).toEqual({ status: "read_back", text: "Earlier report." });
  });
});

describe("await contract", () => {
  const question = { requestId: "q", message: "May I edit db/0007.sql?" };

  it("reports parent attention with the run's one attention state", () => {
    const contract = decoded(
      "subagent_await",
      awaitContract({
        observations: [
          { run: finished("done", { finalText: "ok", reportStatus: "available" }) },
          { run: view({ id: "asks", state: "waiting_for_parent", question }) },
          { run: view({ id: "paused", state: "paused", capabilities: [] }) },
        ],
        fullyRenderedIds: new Set(),
        until: "all_finished",
        requestedRunIds: ["done", "asks", "paused"],
      }),
    );
    expect(contract.outcome).toBe("attention");
    expect(
      contract.targets.map((target) => [target.parentActionRequired, target.attention]),
    ).toEqual([
      [false, undefined],
      [true, { kind: "question", message: question.message }],
      [true, { kind: "paused", canResume: false }],
    ]);
  });

  it("keeps containment visible without claiming parent action while it is in progress", () => {
    const contract = decoded(
      "subagent_await",
      awaitContract({
        observations: [
          { run: containedWriter({ id: "w", state: "running" }) },
          { run: finished("b") },
        ],
        fullyRenderedIds: new Set(),
        until: "any_finished",
        requestedRunIds: ["w", "b"],
      }),
    );
    expect(contract.outcome).toBe("finished");
    expect(contract.targets[0]).toMatchObject({
      parentActionRequired: false,
      attention: { kind: "containment" },
    });
  });

  it("cancels without exposing or consuming any report and keeps requested IDs", () => {
    const secretReport = "FINAL REPORT BODY";
    const contract = decoded(
      "subagent_await",
      cancelledAwaitContract({
        runs: [
          finished("done", { finalText: secretReport, reportStatus: "available" }),
          finished("old", { finalText: secretReport, reportStatus: "delivered" }),
          view({ id: "busy" }),
        ],
        requestedRunIds: ["done", "old", "busy", "never-seen"],
        until: "all_finished",
        cleanup: "unconfirmed",
      }),
    );
    expect(JSON.stringify(contract)).not.toContain(secretReport);
    expect(contract).toMatchObject({
      outcome: "cancelled",
      cleanup: "unconfirmed",
      requestedRunIds: ["done", "old", "busy", "never-seen"],
      unobservedRunIds: ["never-seen"],
    });
    expect(contract.targets.map((target) => target.report.status)).toEqual([
      "deferred",
      "already_delivered",
      "not_finished",
    ]);
  });

  it("does not promise unconsumed reports after delivery was attempted before cancellation", () => {
    const contract = cancelledAwaitContract({
      runs: [finished("a", { finalText: "Recoverable", reportStatus: "available" })],
      requestedRunIds: ["a"],
      until: "all_finished",
      cleanup: "confirmed",
      deliveryAttemptedIds: new Set(["a"]),
    });
    expect(decoded("subagent_await", contract).targets[0]?.report).toEqual({ status: "unknown" });
    expect(JSON.stringify(contract)).not.toContain("Recoverable");
  });

  it("rejects a cancelled contract that carries report text", () => {
    const contract = cancelledAwaitContract({
      runs: [finished("a")],
      requestedRunIds: ["a"],
      until: "all_finished",
      cleanup: "confirmed",
    });
    const target = { ...contract.targets[0]!, report: { status: "delivered", text: "leak" } };
    expect(decodeSubagentContract("subagent_await", { ...contract, targets: [target] })).toBe(
      undefined,
    );
  });
});

describe("retry lineage and failures", () => {
  it("keeps requested predecessors, successors, and per-target uncertainty separate", () => {
    const contract = decoded(
      "subagent_lifecycle",
      lifecycleContract("retry", [
        { runId: "a", run: view({ id: "a-2", predecessorRunId: "a", state: "starting" }) },
        {
          runId: "b",
          failure: { id: "b", code: "retry_cleanup_unconfirmed", message: "Cleanup unknown." },
        },
        { runId: "c", failure: { id: "c", code: "retry_route_exhausted", message: "Exhausted." } },
      ]),
    );
    expect(contract.outcome).toBe("partial");
    expect(contract.results[0]).toMatchObject({
      requestedRunId: "a",
      status: "succeeded",
      target: { runId: "a-2", predecessorRunId: "a", report: { status: "not_finished" } },
    });
    expect(contract.results.slice(1)).toMatchObject([
      { requestedRunId: "b", failure: { disposition: "unconfirmed" } },
      { requestedRunId: "c", failure: { disposition: "failed" } },
    ]);
  });

  it("never exposes report text from a lifecycle receipt", () => {
    const contract = lifecycleContract("stop", [
      {
        runId: "a",
        run: finished("a", { finalText: "REPORT", reportStatus: "delivered" }),
      },
    ]);
    expect(contract.outcome).toBe("succeeded");
    expect(JSON.stringify(contract)).not.toContain("REPORT");
  });

  it("projects retry eligibility only from authoritative recovery for the same run", () => {
    const failed = finished("f", {
      state: "failed",
      reportGeneration: 0,
      remainingCandidateCount: 2,
      supersededByRunId: "f-2",
    });
    const targets = decoded(
      "subagent_status",
      statusContract({
        observations: [
          { run: failed },
          { run: { ...failed, id: "g" }, recovery: recovery("f") },
          {
            run: { ...failed, id: "h" },
            recovery: recovery("h", {
              cleanupDisposition: "quarantined",
              retryDisposition: "blocked",
            }),
          },
        ],
        fullyRenderedIds: new Set(),
        missingRunIds: ["gone"],
      }),
    ).targets;
    expect(targets.map((target) => target.retry)).toEqual([
      undefined,
      undefined,
      { cleanup: "quarantined", disposition: "blocked", remainingCandidateCount: 1 },
    ]);
    expect(targets[0]).toMatchObject({ successorRunId: "f-2" });
  });
});

describe("privacy and strict decoding", () => {
  const leakyRun = view({
    id: "a",
    name: "api_key=sk-name-abcdefghijklmnopqrstuvwxyz",
    task: "TASK-SECRET",
    cwd: "/private/CWD-SECRET",
    sourceCwd: "/private/SOURCE-SECRET",
    pid: 424242,
    sessionId: "NATIVE-SESSION-ID",
    sessionFile: "/sessions/SESSION-FILE",
    sessionEvents: [{ type: "assistant", text: "EVENT-SECRET", createdAt: 1 }],
    progress: "PROGRESS-SECRET",
    state: "failed",
    warning: "retrying with Authorization: Bearer abcdefghijklmnop",
    warningSource: "child",
    systemWarning: "api_key=sk-abcdefghijklmnopqrstuvwxyz",
    error: "\u001b[31mexit 1\u001b[0m token=hunter2-secret",
  });

  it("projects only explicit, redacted metadata", () => {
    const contract = statusContract({
      observations: [{ run: leakyRun }],
      fullyRenderedIds: new Set(["a"]),
      missingRunIds: [],
    });
    const serialized = JSON.stringify(decoded("subagent_status", contract));
    for (const secret of [
      "TASK-SECRET",
      "sk-name-abcdefghijklmnopqrstuvwxyz",
      "CWD-SECRET",
      "SOURCE-SECRET",
      "424242",
      "NATIVE-SESSION-ID",
      "SESSION-FILE",
      "EVENT-SECRET",
      "PROGRESS-SECRET",
      "abcdefghijklmnop",
      "sk-abcdefghijklmnopqrstuvwxyz",
      "hunter2-secret",
      "\u001b",
    ])
      expect(serialized).not.toContain(secret);
    expect(contract.targets[0]?.warnings.map((warning) => warning.source)).toEqual([
      "child",
      "system",
    ]);
  });

  it("accepts only the exact versioned envelope and known keys", () => {
    const contract = statusContract({
      observations: [{ run: finished("a") }],
      fullyRenderedIds: new Set(),
      missingRunIds: [],
    });
    const target = contract.targets[0]!;
    for (const value of [
      { ...contract, extra: true },
      { ...contract, version: 2 },
      { ...contract, contract: "other" },
      { ...contract, targets: [{ ...target, cwd: "/project" }] },
      { ...contract, targets: [{ ...target, report: { status: "unknown", text: "x" } }] },
      null,
      "{}",
    ])
      expect(decodeSubagentContract("subagent_status", value)).toBe(undefined);
    expect(decodeSubagentContract("subagent_await", contract)).toBe(undefined);
    const hostile = Object.defineProperty({ ...contract }, "targets", {
      enumerable: true,
      get: () => {
        throw new Error("hostile");
      },
    });
    expect(decodeSubagentContract("subagent_status", hostile)).toBe(undefined);
    expect(Object.isFrozen(decodeSubagentContract("subagent_status", contract))).toBe(true);
  });
});
