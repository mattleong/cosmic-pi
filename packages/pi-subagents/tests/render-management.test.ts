import { describe, expect, it } from "vitest";
import { failureRecovery } from "../src/tools/render-management.ts";

describe("management failure recovery", () => {
  it("gives action-specific recovery for bounded completion backlog", () => {
    expect(failureRecovery("report_delivery_backlog", "too many outcomes")).toContain(
      "subagent_await",
    );
  });

  it("never recommends retrying a reply with an uncertain delivery outcome", () => {
    expect(failureRecovery("reply_outcome_uncertain", "reply may have arrived")).toBe(
      "Do not resend the reply automatically; inspect subagent_status and wait for the run's next event.",
    );
  });

  it("explains stale question ownership without suggesting another reply", () => {
    const recovery = failureRecovery("question_ownership_mismatch", "question closed");
    expect(recovery).toContain("no longer pending");
    expect(recovery).not.toContain("subagent_reply");
  });
});
