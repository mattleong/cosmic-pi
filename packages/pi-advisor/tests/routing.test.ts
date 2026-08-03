import { describe, expect, test } from "vitest";
import type { AdvisorSeverity } from "../src/review/index.ts";
import {
  ADVISOR_IMMUNITY_COMPLETED_TURNS,
  armAdvisorInterruption,
  clearAdvisorCancellation,
  completeAdvisorPrimaryTurn,
  emptyAdvisorRoutingState,
  isAdvisorImmunityActive,
  latchAdvisorCancellation,
  routeAdvisorFinding,
  type AdvisorParentState,
} from "../src/review/routing.ts";

const states: AdvisorParentState[] = ["active", "idle", "final", "aborting"];
const severities: AdvisorSeverity[] = ["concern", "blocker"];

describe("advisor routing", () => {
  test("covers every severity, parent state, immunity and cancellation combination", () => {
    let cases = 0;
    for (const severity of severities) {
      for (const parentState of states) {
        for (const immunityActive of [false, true]) {
          for (const cancellationLatched of [false, true]) {
            const route = routeAdvisorFinding({
              severity,
              parentState,
              immunityActive,
              cancellationLatched,
              sameTurnStrongSignal: false,
              abortSafe: false,
            });
            expect(["silent", "steer-live", "abort-recover", "trigger-correction"]).toContain(
              route,
            );
            if (cancellationLatched || parentState === "aborting") {
              expect(route).toBe("silent");
            }
            cases += 1;
          }
        }
      }
    }
    expect(cases).toBe(32);
  });

  test("active findings steer while idle findings trigger a correction", () => {
    expect(
      routeAdvisorFinding({
        severity: "concern",
        parentState: "active",
        immunityActive: false,
        cancellationLatched: false,
      }),
    ).toBe("steer-live");
    expect(
      routeAdvisorFinding({
        severity: "blocker",
        parentState: "final",
        immunityActive: false,
        cancellationLatched: false,
      }),
    ).toBe("trigger-correction");
    expect(
      routeAdvisorFinding({
        severity: "concern",
        parentState: "idle",
        immunityActive: true,
        cancellationLatched: false,
      }),
    ).toBe("silent");
  });

  test("only a same-turn strong blocker at a safe boundary can abort", () => {
    const base = {
      severity: "blocker" as const,
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
    let state = armAdvisorInterruption(emptyAdvisorRoutingState());
    expect(ADVISOR_IMMUNITY_COMPLETED_TURNS).toBe(3);
    for (let turn = 1; turn <= 3; turn += 1) {
      state = completeAdvisorPrimaryTurn(state);
      expect(isAdvisorImmunityActive(state), `turn ${turn}`).toBe(true);
    }
    state = completeAdvisorPrimaryTurn(state);
    expect(isAdvisorImmunityActive(state)).toBe(false);
  });

  test("blockers bypass and re-arm immunity while cancellation drops stale findings", () => {
    let state = completeAdvisorPrimaryTurn(armAdvisorInterruption(emptyAdvisorRoutingState()));
    expect(
      routeAdvisorFinding({
        severity: "blocker",
        parentState: "final",
        immunityActive: isAdvisorImmunityActive(state),
        cancellationLatched: false,
      }),
    ).toBe("trigger-correction");
    state = armAdvisorInterruption(state);
    expect(state.immunityUntilCompletedTurn).toBe(4);
    state = latchAdvisorCancellation(state);
    expect(
      routeAdvisorFinding({
        severity: "blocker",
        parentState: "idle",
        immunityActive: isAdvisorImmunityActive(state),
        cancellationLatched: state.cancellationLatched,
      }),
    ).toBe("silent");
    state = clearAdvisorCancellation(state);
    expect(state.cancellationLatched).toBe(false);
  });
});
