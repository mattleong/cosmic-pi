import { describe, expect, it } from "@effect/vitest";
import {
  isWorkflowRunLiveElsewhere,
  isWorkflowRunNoticeOwed,
  WORKFLOW_RUN_HEARTBEAT_MS,
  type WorkflowRunLiveness,
  type WorkflowRunRecord,
} from "../../src/workflow/run-record.ts";

const NOW = 10 * WORKFLOW_RUN_HEARTBEAT_MS;
const BOOTED_AT = NOW - WORKFLOW_RUN_HEARTBEAT_MS;
const THIS_PID = 100;
const OTHER_PID = 200;

const record = (patch: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord => ({
  version: 1,
  runId: "wf-a-1",
  sessionKey: "session",
  name: "review",
  source: { kind: "inline" },
  pid: OTHER_PID,
  bootedAt: BOOTED_AT,
  startedAt: 0,
  state: "running",
  notified: false,
  ...patch,
});

/** The other process is alive, and its run's directory was written `age` ago. */
const liveness = (age: number | undefined, alive = true): WorkflowRunLiveness => ({
  currentPid: THIS_PID,
  bootedAt: BOOTED_AT,
  now: NOW,
  writtenAt: age === undefined ? undefined : NOW - age,
  isAlive: (pid) => pid === THIS_PID || alive,
});

describe("a workflow run record's process", () => {
  it("still runs the run while its pid is alive and its directory stays recent", () => {
    expect(isWorkflowRunLiveElsewhere(record(), liveness(WORKFLOW_RUN_HEARTBEAT_MS))).toBe(true);
    // Without a heartbeat to go by, a live pid is trusted.
    expect(isWorkflowRunLiveElsewhere(record(), liveness(undefined))).toBe(true);
  });

  it("is gone when its pid is dead, names this process, or its heartbeat stopped", () => {
    expect(isWorkflowRunLiveElsewhere(record(), liveness(0, false))).toBe(false);
    expect(isWorkflowRunLiveElsewhere(record({ pid: THIS_PID }), liveness(0))).toBe(false);
    // A reused pid is alive, but nothing refreshes the dead run's directory.
    const stale = liveness(WORKFLOW_RUN_HEARTBEAT_MS + 1);
    expect(isWorkflowRunLiveElsewhere(record(), stale)).toBe(false);
    expect(isWorkflowRunNoticeOwed(record(), stale)).toBe(true);
  });

  it("owes a notice for an ended run only once the process that would report it is gone", () => {
    const ended = record({ state: "completed", endedAt: 1 });
    expect(isWorkflowRunNoticeOwed(ended, liveness(0))).toBe(false);
    expect(isWorkflowRunNoticeOwed(ended, liveness(0, false))).toBe(true);
    expect(isWorkflowRunNoticeOwed({ ...ended, pid: THIS_PID }, liveness(0))).toBe(true);
    expect(isWorkflowRunNoticeOwed(record({ state: "interrupted" }), liveness(0))).toBe(true);
  });

  it("is gone when it ran before this machine booted, whatever process now holds its pid", () => {
    // A boot a few hours earlier: the pid is alive, and the directory was written recently.
    const earlierBoot = { bootedAt: BOOTED_AT - 4 * WORKFLOW_RUN_HEARTBEAT_MS };
    expect(isWorkflowRunLiveElsewhere(record(earlierBoot), liveness(0))).toBe(false);
    expect(isWorkflowRunNoticeOwed(record(earlierBoot), liveness(0))).toBe(true);
    const ended = record({ ...earlierBoot, state: "completed", endedAt: 1 });
    expect(isWorkflowRunNoticeOwed(ended, liveness(0))).toBe(true);
    // A wall-clock adjustment of a few seconds doesn't make it another boot.
    expect(isWorkflowRunLiveElsewhere(record({ bootedAt: BOOTED_AT + 5_000 }), liveness(0))).toBe(
      true,
    );
    // A record without a boot time is judged by its pid.
    const { bootedAt: _bootedAt, ...unbooted } = record();
    expect(isWorkflowRunLiveElsewhere(unbooted, liveness(0))).toBe(true);
  });

  it("owes nothing once a notice or report was accepted", () => {
    for (const state of ["running", "completed", "failed", "stopped", "interrupted"] as const)
      expect(isWorkflowRunNoticeOwed(record({ state, notified: true }), liveness(0, false))).toBe(
        false,
      );
  });
});
