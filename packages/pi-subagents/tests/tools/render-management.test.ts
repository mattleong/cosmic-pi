import { describe, expect, it } from "vitest";
import { failureRecovery } from "../../src/tools/render-management.ts";
import { AUTOMATIC_ROUTING_FAILURE_CODES } from "../../src/profiles/automatic-selection.ts";

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

  it("falls back to context-specific generic guidance for unknown failures", () => {
    const actionFallback = failureRecovery("mystery", "unexplained", "action");
    const startFallback = failureRecovery("mystery", "unexplained", "start");
    expect(actionFallback).not.toEqual(startFallback);
    expect(failureRecovery(undefined, "", "action")).toEqual(actionFallback);
    expect(failureRecovery(undefined, "", "start")).toEqual(startFallback);
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

  it("routes known automatic selection failures to manual selection, not route recovery", () => {
    const manual = failureRecovery(AUTOMATIC_ROUTING_FAILURE_CODES[0], "", "start");
    const generic = failureRecovery("automatic_routing_unknown", "", "start");
    const route = failureRecovery("profile_candidate_invalid", "", "start");
    expect(manual).not.toEqual(generic);
    expect(manual).not.toEqual(route);
    for (const code of AUTOMATIC_ROUTING_FAILURE_CODES) {
      expect(failureRecovery(code.toUpperCase(), "", "start")).toEqual(manual);
      expect(failureRecovery(code, "", "action")).not.toEqual(manual);
    }
  });

  it("matches codes case-insensitively", () => {
    expect(failureRecovery("REPLY_TOO_LARGE", "")).toEqual(failureRecovery("reply_too_large", ""));
  });
});
