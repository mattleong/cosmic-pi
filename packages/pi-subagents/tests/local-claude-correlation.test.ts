import { describe, expect, it } from "vitest";
import {
  SENT_UUID_LIMIT,
  componentwiseMax,
  cumulativeUsageDelta,
  isInternalReplayOrigin,
  makeClaudeResultCorrelation,
  usageComponentsTotal,
  zeroUsageComponents,
  type UsageComponents,
} from "../src/backend/local-claude-correlation.ts";

const components = (overrides: Partial<UsageComponents> = {}): UsageComponents => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  ...overrides,
});

describe("local Claude usage arithmetic", () => {
  it("accounts repeated cumulative usage for the same message as nonnegative deltas", () => {
    const first = cumulativeUsageDelta(zeroUsageComponents, components({ input: 10, output: 4 }));
    expect(first.delta).toEqual(components({ input: 10, output: 4 }));
    expect(first.inconsistent).toBe(false);
    // The same native message id repeats a larger cumulative snapshot; only the
    // difference over the retained componentwise maximum is accounted.
    const retained = componentwiseMax(zeroUsageComponents, components({ input: 10, output: 4 }));
    const second = cumulativeUsageDelta(
      retained,
      components({ input: 12, output: 4, cacheRead: 3 }),
    );
    expect(second.delta).toEqual(components({ input: 2, cacheRead: 3 }));
    expect(second.inconsistent).toBe(false);
    expect(usageComponentsTotal(second.delta)).toBe(5);
  });

  it("flags a regressing cumulative total as inconsistent and never subtracts", () => {
    const previous = components({ input: 10, output: 6, cacheWrite: 2 });
    const { delta, inconsistent } = cumulativeUsageDelta(
      previous,
      components({ input: 8, output: 7, cacheWrite: 2 }),
    );
    expect(inconsistent).toBe(true);
    expect(delta).toEqual(components({ output: 1 }));
  });
});

describe("local Claude result correlation", () => {
  it("takes an expectation by its exact user_message_uuid", () => {
    const correlation = makeClaudeResultCorrelation();
    correlation.register(
      { uuid: "uuid-a", kind: "assignment", epoch: 1 },
      components({ input: 5 }),
    );
    correlation.register({ uuid: "uuid-b", kind: "synthetic", epoch: 1 }, zeroUsageComponents);
    const taken = correlation.take("uuid-b", undefined);
    expect(taken).toMatchObject({ uuid: "uuid-b", kind: "synthetic", epoch: 1 });
    // Consumed exactly once, and the direct take never disturbs other entries.
    expect(correlation.take("uuid-b", undefined)).toBeUndefined();
    expect(correlation.take("uuid-a", undefined)).toMatchObject({
      uuid: "uuid-a",
      usageBaseline: components({ input: 5 }),
    });
  });

  it("selects the oldest synthetic expectation for an internal origin without a UUID", () => {
    const correlation = makeClaudeResultCorrelation();
    correlation.register({ uuid: "assign-1", kind: "assignment", epoch: 3 }, zeroUsageComponents);
    correlation.register({ uuid: "synth-1", kind: "synthetic", epoch: 3 }, zeroUsageComponents);
    correlation.register({ uuid: "synth-2", kind: "synthetic", epoch: 3 }, zeroUsageComponents);
    expect(isInternalReplayOrigin("task-notification")).toBe(true);
    expect(isInternalReplayOrigin("auto-continuation")).toBe(true);
    expect(isInternalReplayOrigin(undefined)).toBe(false);
    // A synthetic-origin result skips the pending assignment expectation.
    expect(correlation.take(undefined, "task-notification")).toMatchObject({ uuid: "synth-1" });
    // A plain missing-UUID result falls back to the issue-order FIFO head.
    expect(correlation.take(undefined, undefined)).toMatchObject({ uuid: "assign-1" });
    expect(correlation.take(undefined, "auto-continuation")).toMatchObject({ uuid: "synth-2" });
    expect(correlation.take(undefined, "task-notification")).toBeUndefined();
  });

  it("evicts the oldest expectation beyond the 64-entry FIFO bound", () => {
    const correlation = makeClaudeResultCorrelation();
    for (let index = 0; index < SENT_UUID_LIMIT + 1; index += 1)
      correlation.register(
        { uuid: `uuid-${index}`, kind: "assignment", epoch: index },
        zeroUsageComponents,
      );
    expect(correlation.take("uuid-0", undefined)).toBeUndefined();
    expect(correlation.take(undefined, undefined)).toMatchObject({ uuid: "uuid-1" });
    expect(correlation.take(`uuid-${SENT_UUID_LIMIT}`, undefined)).toMatchObject({
      uuid: `uuid-${SENT_UUID_LIMIT}`,
    });
  });

  it("bounds the confirmed sent-UUID window and clears all state", () => {
    const correlation = makeClaudeResultCorrelation();
    for (let index = 0; index < SENT_UUID_LIMIT + 1; index += 1)
      correlation.rememberSentUuid(`sent-${index}`);
    expect(correlation.hasSentUuid("sent-0")).toBe(false);
    expect(correlation.hasSentUuid("sent-1")).toBe(true);
    expect(correlation.hasSentUuid(`sent-${SENT_UUID_LIMIT}`)).toBe(true);
    correlation.register({ uuid: "uuid-a", kind: "assignment", epoch: 1 }, zeroUsageComponents);
    correlation.clear();
    expect(correlation.hasSentUuid("sent-1")).toBe(false);
    expect(correlation.take("uuid-a", undefined)).toBeUndefined();
  });
});
