import { assert, describe, expect, it } from "vitest";
import type { FailedStartRecovery, SubagentRunView } from "../../src/run/model.ts";
import type { SubagentRunObservation } from "../../src/run/service.ts";
import {
  awaitContract,
  cancelledAwaitContract,
  readStatusTarget,
  startContract,
} from "../../src/tools/contract.ts";
import {
  decodeSubagentContract,
  type SubagentContract,
  type SubagentContractTool,
} from "../../src/tools/contract-schema.ts";
import { view } from "../fixtures/run-view.ts";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

const decoded = <Tool extends SubagentContractTool, Contract extends SubagentContract<Tool>>(
  tool: Tool,
  contract: Contract,
): Contract => {
  expect(decodeSubagentContract(tool)(contract)).toEqual(contract);
  return contract;
};

/** Observed targets as an await returns them. */
const observedTargets = (observations: ReadonlyArray<SubagentRunObservation>) =>
  decoded(
    "agent_await",
    awaitContract({
      observations,
      until: "all_finished",
      requestedRunIds: Arr.map(observations, (observation) => observation.run.id),
    }),
  ).targets;

const receipt = (id: string) => ({ id, generation: 1, claimToken: `claim-${id}` });
const finished = (id: string, overrides: Partial<SubagentRunView> = {}) =>
  view({ id, name: id, state: "completed", reportGeneration: 1, ...overrides });
const recovery = (runId: string, overrides: Partial<FailedStartRecovery> = {}) =>
  ({
    runId,
    cleanupDisposition: "confirmed",
    ...overrides,
  }) satisfies FailedStartRecovery;

describe("start contract", () => {
  it("keeps request order, full started IDs, and admitted-run recovery for a partial batch", () => {
    const longId = `run-${Fn.pipe("x", Str.repeat(300))}`;
    const contract = decoded(
      "agent_start",
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
    expect(Arr.map(contract.launches, (launch) => [launch.index, launch.status])).toEqual([
      [0, "started"],
      [1, "failed"],
      [2, "failed"],
    ]);
    expect(contract.launches[0]).toMatchObject({ runId: longId, profile: "worker" });
    expect(contract.launches[1]).toMatchObject({
      name: "second",
      profile: "reviewer",
      failure: { disposition: "failed", code: "SubagentProcessError" },
      admittedRun: { runId: "run-2", cleanup: "confirmed" },
    });
    expect(contract.launches[2]).toMatchObject({ failure: { disposition: "unconfirmed" } });
    expect(contract.launches[2]).not.toHaveProperty("admittedRun");
  });
});

describe("report disposition", () => {
  const report = (observation: SubagentRunObservation) => observedTargets([observation])[0]!.report;

  it("delivers every claimed report: a saved one as its file, an unsaved one as a preview", () => {
    const reportArchive = { path: "/agent/reports/a-1.md", chars: 5, lines: 1, complete: true };
    const saved = finished("a", { finalText: "Done.", reportStatus: "available", reportArchive });
    expect(report({ run: saved, completionReceipt: receipt("a") })).toEqual({
      status: "delivered",
      ...reportArchive,
    });
    const run = finished("a", { finalText: "Done.", reportStatus: "available" });
    expect(report({ run, completionReceipt: receipt("a") })).toEqual({
      status: "delivered",
      text: "Done.",
      truncated: false,
    });
    const long = finished("a", {
      finalText: Fn.pipe("x", Str.repeat(10_000)),
      reportStatus: "available",
    });
    expect(report({ run: long, completionReceipt: receipt("a") })).toMatchObject({
      status: "delivered",
      truncated: true,
    });
    expect(report({ run: finished("a", { finalText: "Done." }) })).toEqual({
      status: "unknown",
    });
  });
});

describe("failures", () => {
  it("preview a long error and name its saved file", () => {
    const errorArchive = {
      path: "/agent/reports/a-failure-1.md",
      chars: 8_000,
      lines: 9,
      complete: true,
    };
    const [target] = observedTargets([
      {
        run: view({
          id: "a",
          state: "failed",
          error: `FAILURE ${Fn.pipe("x", Str.repeat(8_000))}`,
          errorArchive,
        }),
      },
    ]);
    assert(target?.error !== undefined);
    expect(Fn.pipe(target.error, Str.startsWith("FAILURE"))).toBe(true);
    expect(target?.error?.length).toBeLessThan(1_000);
    expect(target?.errorFile).toEqual(errorArchive);
  });
});

describe("await contract", () => {
  it("cancels without exposing or consuming any report and keeps requested IDs", () => {
    const secretReport = "FINAL REPORT BODY";
    const contract = decoded(
      "agent_await",
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
    expect(Arr.map(contract.targets, (target) => target.report.status)).toEqual([
      "deferred",
      "already_delivered",
      "not_finished",
    ]);
  });
});

describe("cleanup evidence", () => {
  const quarantined = view({
    writeIntent: "writer",
    state: "stopped",
    cleanup: {
      disposition: "quarantined",
      recovery: "manual",
      diagnostic: {
        phase: "writer-lease",
        code: Fn.pipe("x", Str.repeat(100)),
        message: `token=lease-secret\n${Fn.pipe("detail ", Str.repeat(300))}`,
      },
    },
  });

  it("redacts bounded cleanup diagnostics in a read's status", () => {
    const target = readStatusTarget(quarantined);
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
    childWarning: "retrying with Authorization: Bearer abcdefghijklmnop",
    systemWarning: "api_key=sk-abcdefghijklmnopqrstuvwxyz",
    error: "\u001b[31mexit 1\u001b[0m token=hunter2-secret",
  });

  it("projects only explicit, redacted metadata", () => {
    const targets = observedTargets([{ run: leakyRun }]);
    const serialized = JSON.stringify(targets);
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
    assert(targets[0] !== undefined);
    expect(Arr.map(targets[0].warnings, (warning) => warning.source)).toEqual(["child", "system"]);
  });
});
