import { describe, expect, test } from "vitest";
import {
  ADVISOR_IMMUNITY_COMPLETED_TURNS,
  AdvisorRoutingState,
  routeAdvisorFinding,
  type AdvisorParentState,
} from "../src/routing.ts";
import type { AdvisorReviewPolicy } from "../src/config.ts";
import type { AdvisorSeverity } from "../src/review.ts";

const states: AdvisorParentState[] = ["active", "idle", "final", "aborting"];
const policies: AdvisorReviewPolicy[] = ["guardrail", "strict", "advice", "manual"];
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
                "preserve-next-turn",
                "steer-live",
                "abort-recover",
                "trigger-correction",
              ]).toContain(route);
              if (severity === "nit") expect(route).toBe("silent");
              if (cancellationLatched && severity !== "nit" && route !== "silent") {
                expect(route).toBe("preserve-next-turn");
              }
              cases += 1;
            }
          }
        }
      }
    }
    expect(cases).toBe(192);
  });

  test("guardrail concerns preserve via next turn and strict concerns respect immunity", () => {
    expect(
      routeAdvisorFinding({
        severity: "concern",
        policy: "guardrail",
        parentState: "active",
        immunityActive: false,
        cancellationLatched: false,
      }),
    ).toBe("preserve-next-turn");
    expect(
      routeAdvisorFinding({
        severity: "concern",
        policy: "strict",
        parentState: "active",
        immunityActive: false,
        cancellationLatched: false,
      }),
    ).toBe("steer-live");
    expect(
      routeAdvisorFinding({
        severity: "concern",
        policy: "strict",
        parentState: "active",
        immunityActive: true,
        cancellationLatched: false,
      }),
    ).toBe("preserve-next-turn");
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

  test("blockers bypass and re-arm immunity while cancellation stays preserved", () => {
    const state = new AdvisorRoutingState();
    state.armInterruption();
    state.completePrimaryTurn();
    expect(
      routeAdvisorFinding({
        severity: "blocker",
        policy: "strict",
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
        policy: "strict",
        parentState: "idle",
        immunityActive: state.immunityActive,
        cancellationLatched: state.cancellationLatched,
      }),
    ).toBe("preserve-next-turn");
    state.clearCancellationForGenuineUserPrompt();
    expect(state.cancellationLatched).toBe(false);
  });
});
