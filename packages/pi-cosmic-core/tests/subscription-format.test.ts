import { isFunctionValue } from "../src/runtime-values.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  clampPercent,
  formatPercent,
  formatResetClock,
  formatTokens,
  formatWindowedUsageLine,
  remainingResetSeconds,
} from "../src/subscription-format.ts";
import {
  captureHostSignal,
  captureSessionHost,
  hasTerminalUI,
  isProjectTrusted,
  notifyAtHostBoundary,
  type HostNotifierContext,
} from "../src/host-session.ts";
import { withUsageEligibility } from "../src/usage-projection.ts";

describe("subscription-format helpers", () => {
  it("formats percents and token counts", () => {
    expect(clampPercent(120)).toBe(100);
    expect(clampPercent(-5)).toBe(0);
    expect(formatPercent(null)).toBe("--");
    expect(formatPercent(79.4)).toBe("79%");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_200)).toBe("1.2k");
    expect(formatTokens(15_000)).toBe("15k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(12_000_000)).toBe("12M");
  });

  it("assembles windowed usage status lines", () => {
    const now = 1_700_000_000_000;
    const capturedAt = now - 60_000;
    expect(remainingResetSeconds(120, capturedAt, now)).toBe(60);
    expect(
      formatWindowedUsageLine(
        [
          { label: "5h", leftPercent: 80, resetInSeconds: null },
          { label: "7d", leftPercent: null, resetInSeconds: null },
        ],
        { showResetTimes: false },
        now,
        capturedAt,
      ),
    ).toBe("Usage: 5h: 80%");
  });

  it("rejects invalid reset instants without throwing", () => {
    const now = 1_700_000_000_000;
    expect(formatResetClock(1e300, undefined, now)).toBeNull();
    expect(formatResetClock(60, undefined, Number.NaN)).toBeNull();
    expect(remainingResetSeconds(60, Number.NaN, now)).toBeNull();
    expect(
      formatWindowedUsageLine(
        [{ label: "5h", leftPercent: 80, resetInSeconds: 1e300 }],
        { showResetTimes: true },
        now,
        now,
      ),
    ).toBe("Usage: 5h: 80%");
  });
});

describe("host-session helpers", () => {
  it("reads UI, trust, and session host fields without throwing", () => {
    expect(hasTerminalUI({ mode: "tui" })).toBe(true);
    expect(hasTerminalUI({ mode: undefined, hasUI: true })).toBe(true);
    expect(hasTerminalUI({ mode: "rpc" })).toBe(false);
    expect(isProjectTrusted({ isProjectTrusted: () => true })).toBe(true);
    expect(isProjectTrusted({})).toBe(false);
    expect(isProjectTrusted({ isProjectTrusted: () => false })).toBe(false);
    expect(isProjectTrusted({ isProjectTrusted: true })).toBe(false);
    expect(isProjectTrusted({ isProjectTrusted: () => "true" })).toBe(false);
    expect(
      isProjectTrusted({
        get isProjectTrusted() {
          throw new Error("hostile trust getter");
        },
      }),
    ).toBe(false);
    expect(
      isProjectTrusted({
        isProjectTrusted: () => {
          throw new Error("hostile trust callback");
        },
      }),
    ).toBe(false);
    expect(captureHostSignal({ signal: undefined })).toEqual({
      _tag: "Captured",
      signal: undefined,
    });
    expect(captureSessionHost({ cwd: "/tmp/project", signal: undefined })).toEqual({
      _tag: "Captured",
      cwd: "/tmp/project",
      signal: undefined,
      aborted: false,
    });
    expect(captureSessionHost({ cwd: "" })).toEqual({ _tag: "Unavailable" });
  });

  it("contains throwing and rejecting-thenable notify runtimes without unhandled rejections", () => {
    const throwing: HostNotifierContext = {
      ui: {
        notify: () => {
          throw new Error("hostile notify");
        },
      },
    };
    expect(() => notifyAtHostBoundary(throwing, "message", "info")).not.toThrow();

    // Pi documents `notify` as synchronous void; a runtime that returns a rejecting thenable
    // anyway must have its rejection observed by the boundary instead of leaking unhandled.
    let rejectionObserved = false;
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const rejecting = {
      ui: {
        notify: () => ({
          // oxlint-disable-next-line unicorn/no-thenable -- simulates the contract-violating runtime under test
          then: (_onResolve?: () => void, onReject?: (reason: Error) => void): void => {
            rejectionObserved = isFunctionValue(onReject);
            onReject?.(new Error("late notify failure"));
          },
        }),
      },
    } as HostNotifierContext;
    expect(() => notifyAtHostBoundary(rejecting, "message", "warning")).not.toThrow();
    expect(rejectionObserved).toBe(true);

    // Even a hostile thenable whose `then` itself throws stays contained.
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const hostileThenable = {
      ui: {
        notify: () => ({
          // oxlint-disable-next-line unicorn/no-thenable -- simulates the contract-violating runtime under test
          then: () => {
            throw new Error("hostile then");
          },
        }),
      },
    } as HostNotifierContext;
    expect(() => notifyAtHostBoundary(hostileThenable, "message", "error")).not.toThrow();
  });
});

describe("usage projection helpers", () => {
  it("clears and hides usage visibility fields", () => {
    const base = {
      eligible: true,
      snapshot: { value: 1 },
      statusLine: "Usage: 5h: 80%",
      error: "boom",
      updatedAt: 10,
      statusText: "ok",
    };
    expect(
      withUsageEligibility(base, false, false, {
        hiddenStatusText: "hidden",
      }),
    ).toMatchObject({
      eligible: false,
      snapshot: { value: 1 },
      statusLine: undefined,
      error: undefined,
      statusText: "hidden",
    });
    expect(
      withUsageEligibility(base, true, true, {
        hiddenStatusText: "hidden",
      }),
    ).toMatchObject({
      eligible: true,
      snapshot: undefined,
      statusLine: undefined,
      error: undefined,
      updatedAt: undefined,
      statusText: "Usage unavailable.",
    });
  });
});
