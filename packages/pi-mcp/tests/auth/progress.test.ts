import { describe, expect, it } from "vitest";
import { authCanReopen, type McpAuthProgress } from "../../src/auth/progress.ts";

const waiting: McpAuthProgress = {
  attemptId: 1,
  server: "owned",
  mode: "local",
  phase: "awaiting-callback",
  startedAt: 0,
  updatedAt: 100,
  deadline: 1_000,
  canReopen: true,
  credentialsSaved: false,
  mutation: "idle",
};
describe("auth action evidence", () => {
  it("only permits browser reopen during a live local handoff with an enforced deadline", () => {
    expect(authCanReopen(waiting, 999)).toBe(true);
    expect(authCanReopen(waiting, 1_000)).toBe(false);
    expect(authCanReopen({ ...waiting, mode: "manual" }, 100)).toBe(false);
    for (const phase of [
      "exchange",
      "saving",
      "finalizing",
      "cancelling",
      "cancelled",
      "succeeded",
      "failed",
    ] as const)
      expect(authCanReopen({ ...waiting, phase }, 100)).toBe(false);
    const { deadline: _deadline, ...withoutDeadline } = waiting;
    expect(authCanReopen(withoutDeadline, 100)).toBe(false);
    expect(authCanReopen({ ...waiting, canReopen: false }, 100)).toBe(false);
  });
});
