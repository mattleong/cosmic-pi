import { describe, expect, it } from "vitest";
import type { FailedStartRecovery, SubagentRunView } from "../../src/run/model.ts";
import type { SubagentRunObservation } from "../../src/run/service.ts";
import { cancelledAwaitContract, startContract, statusContract } from "../../src/tools/contract.ts";
import {
  decodeSubagentContract,
  type SubagentContract,
  type SubagentContractTool,
} from "../../src/tools/contract-schema.ts";
import { containedWriter, view } from "../fixtures/run-view.ts";

const decoded = <Tool extends SubagentContractTool>(
  tool: Tool,
  contract: SubagentContract<Tool>,
): SubagentContract<Tool> => {
  const result = decodeSubagentContract(tool)(contract);
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
    expect(report({ run, completionReceipt: receipt("a") })).toEqual({ status: "deferred" });
    expect(report({ run: finished("a", { finalText: "Done." }) }, ["a"])).toEqual({
      status: "unknown",
    });
  });
});

describe("await contract", () => {
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
});

describe("cleanup evidence", () => {
  it("preserves claim containment and independently redacts bounded cleanup diagnostics", () => {
    const target = decoded(
      "subagent_status",
      statusContract({
        observations: [
          {
            run: containedWriter({
              state: "completed",
              cleanup: {
                disposition: "quarantined",
                recovery: "manual",
                diagnostic: {
                  phase: "writer-lease",
                  code: "x".repeat(100),
                  message: `token=lease-secret\n${"detail ".repeat(300)}`,
                },
              },
            }),
          },
        ],
        fullyRenderedIds: new Set(),
        missingRunIds: [],
      }),
    ).targets[0]!;
    expect(target.attention).toMatchObject({ kind: "containment" });
    expect(target.cleanup?.diagnostic?.code?.length).toBeLessThanOrEqual(80);
    expect(target.cleanup?.diagnostic?.message.length).toBeLessThanOrEqual(1_024);
    expect(JSON.stringify(target)).not.toContain("lease-secret");
    expect(target.cleanup?.recovery).toBe("manual");
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
});
