import { describe, expect, it } from "vitest";
import { failureRecovery } from "../../src/tools/compact-action-failures.ts";

describe("failure recovery guidance", () => {
  it("gives start and action failures different guidance for the same route code", () => {
    const start = failureRecovery("profile_candidate_invalid", "Route rejected.", "start");
    const action = failureRecovery("profile_candidate_invalid", "Route rejected.", "action");
    expect(start).not.toEqual(action);
    expect(failureRecovery("profile_candidate_invalid", "Route rejected.")).toEqual(action);
  });

  it("matches message-only rules without a code and ignores the message for code-only rules", () => {
    const notFound = failureRecovery("run_not_found", "");
    expect(failureRecovery(undefined, "Run agent-9 was NOT FOUND")).toEqual(notFound);
    expect(failureRecovery(undefined, "The profile route is invalid")).toEqual(
      failureRecovery(undefined, "Something else happened"),
    );
  });

  it("sends workflow-owned rejections to the workflow instead of a generic retry", () => {
    const owned = failureRecovery("workflow_owned_run", "");
    expect(owned).toContain("subagent_workflow");
    expect(owned).not.toEqual(failureRecovery("mystery", "", "action"));
  });

  it("falls back to context-specific generic guidance for unknown failures", () => {
    const actionFallback = failureRecovery("mystery", "unexplained", "action");
    const startFallback = failureRecovery("mystery", "unexplained", "start");
    expect(actionFallback).not.toEqual(startFallback);
    expect(failureRecovery(undefined, "", "action")).toEqual(actionFallback);
    expect(failureRecovery(undefined, "", "start")).toEqual(startFallback);
    expect(failureRecovery("automatic_routing_low_confidence", "", "start")).toEqual(startFallback);
    expect(failureRecovery("run_not_found", "")).not.toEqual(actionFallback);
  });

  it("never gives retry-shaped guidance for uncertain outcomes or unconfirmed cleanup", () => {
    for (const context of ["start", "action"] as const)
      for (const code of [
        "steer_outcome_uncertain",
        "start_outcome_uncertain",
        "writer_lease_cleanup_unconfirmed",
        "profile_harness_cleanup_unconfirmed",
        "retry_outcome_uncertain",
        "reply_outcome_uncertain",
      ]) {
        const recovery = failureRecovery(code, "Evidence", context);
        expect(recovery).toMatch(/do not (resend|retry)/i);
        expect(recovery).not.toMatch(/then retry|before retrying|resend it/i);
      }
  });

  it("matches codes case-insensitively", () => {
    expect(failureRecovery("REPLY_TOO_LARGE", "")).toEqual(failureRecovery("reply_too_large", ""));
  });
});
