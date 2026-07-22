import { describe, expect, test } from "vitest";
import {
  ADVISOR_IMMUNITY_COMPLETED_TURNS,
  AdvisorRoutingState,
  routeAdvisorFinding,
  type AdvisorParentState,
} from "../src/review/routing.ts";
import type { AdvisorReviewPolicy } from "../src/config/options.ts";
import type { AdvisorSeverity } from "../src/review/index.ts";

const states: AdvisorParentState[] = ["active", "idle", "final", "aborting"];
const policies: AdvisorReviewPolicy[] = ["corrective", "guardrail", "advisory"];
const severities: AdvisorSeverity[] = ["nit", "concern", "blocker"];

describe("advisor routing", () => {
  test("covers every severity, policy, parent state, immunity and cancellation combination", () => {
    let cases = 0;
    for (const severity of severities) {
      for (const policy of policies) {
        for (const parentState of states) {
          for (const immunityActive of [false, true]) {
            for (const cancellationLatched of [false, true]) {
              const route = routeAdvisorFinding({
                severity,
                policy,
                parentState,
                immunityActive,
                cancellationLatched,
                sameTurnStrongSignal: false,
                abortSafe: false,
              });
              expect([
                "silent",
                "push-direct",
                "steer-live",
                "abort-recover",
                "trigger-correction",
              ]).toContain(route);
              if (severity === "nit" || cancellationLatched || parentState === "aborting") {
                expect(route).toBe("silent");
              }
              cases += 1;
            }
          }
        }
      }
    }
    expect(cases).toBe(144);
  });

  test("guardrail concerns push directly and corrective concerns respect immunity", () => {
    expect(
      routeAdvisorFinding({
        severity: "concern",
        policy: "guardrail",
        parentState: "active",
        immunityActive: false,
        cancellationLatched: false,
      }),
    ).toBe("push-direct");
    expect(
      routeAdvisorFinding({
        severity: "concern",
        policy: "corrective",
        parentState: "active",
        immunityActive: false,
        cancellationLatched: false,
      }),
    ).toBe("steer-live");
    expect(
      routeAdvisorFinding({
        severity: "concern",
        policy: "corrective",
        parentState: "active",
        immunityActive: true,
        cancellationLatched: false,
      }),
    ).toBe("silent");
  });

  test.each([
    ["advisory", "concern"],
    ["advisory", "blocker"],
    ["guardrail", "concern"],
  ] as const)("automatic direct %s %s advice is immediate-or-drop", (policy, severity) => {
    expect(
      routeAdvisorFinding({
        severity,
        policy,
        parentState: "active",
        immunityActive: false,
        cancellationLatched: false,
      }),
    ).toBe("push-direct");
    expect(
      routeAdvisorFinding({
        severity,
        policy,
        parentState: "final",
        immunityActive: false,
        cancellationLatched: false,
      }),
    ).toBe("silent");
  });

  test("only a same-turn strong blocker at a safe boundary can abort", () => {
    const base = {
      severity: "blocker" as const,
      policy: "guardrail" as const,
      parentState: "active" as const,
      immunityActive: true,
      cancellationLatched: false,
    };
    expect(routeAdvisorFinding({ ...base, sameTurnStrongSignal: false, abortSafe: true })).toBe(
      "steer-live",
    );
    expect(routeAdvisorFinding({ ...base, sameTurnStrongSignal: true, abortSafe: false })).toBe(
      "steer-live",
    );
    expect(routeAdvisorFinding({ ...base, sameTurnStrongSignal: true, abortSafe: true })).toBe(
      "abort-recover",
    );
  });

  test("exactly three subsequently completed turns retain concern immunity", () => {
    const state = new AdvisorRoutingState();
    state.armInterruption();
    expect(ADVISOR_IMMUNITY_COMPLETED_TURNS).toBe(3);
    for (let turn = 1; turn <= 3; turn += 1) {
      state.completePrimaryTurn();
      expect(state.immunityActive, `turn ${turn}`).toBe(true);
    }
    state.completePrimaryTurn();
    expect(state.immunityActive).toBe(false);
  });

  test("blockers bypass and re-arm immunity while cancellation drops stale findings", () => {
    const state = new AdvisorRoutingState();
    state.armInterruption();
    state.completePrimaryTurn();
    expect(
      routeAdvisorFinding({
        severity: "blocker",
        policy: "corrective",
        parentState: "final",
        immunityActive: state.immunityActive,
        cancellationLatched: false,
      }),
    ).toBe("trigger-correction");
    state.armInterruption();
    expect(state.snapshot.immunityUntilCompletedTurn).toBe(4);
    state.latchCancellation();
    expect(
      routeAdvisorFinding({
        severity: "blocker",
        policy: "corrective",
        parentState: "idle",
        immunityActive: state.immunityActive,
        cancellationLatched: state.cancellationLatched,
      }),
    ).toBe("silent");
    state.clearCancellationForGenuineUserPrompt();
    expect(state.cancellationLatched).toBe(false);
  });
});
