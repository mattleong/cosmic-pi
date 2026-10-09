import { describe, expect, it } from "vitest";
import { makeThroughputMeter } from "../src/working/throughput.ts";

describe("main-agent call throughput", () => {
  it("requires an observed call start and enough time for a live estimate", () => {
    const meter = makeThroughputMeter();
    meter.output(400);
    meter.finish(1_000, 100);
    expect(meter.rate(1_000)).toBeUndefined();
    meter.start(1_000);
    meter.output(400);
    expect(meter.rate(1_999)).toBeUndefined();
    expect(meter.rate(2_000)).toEqual({ kind: "live", tokensPerSecond: 100 });
  });

  it("includes pre-output latency instead of assigning the first chunk zero generation time", () => {
    const meter = makeThroughputMeter();
    meter.start(0);
    meter.output(400);
    expect(meter.rate(10_000)).toEqual({ kind: "live", tokensPerSecond: 10 });
    meter.finish(10_000, 200);
    expect(meter.rate(10_000)).toEqual({ kind: "completed", tokensPerSecond: 20 });
  });

  it("reconciles buffered and hidden-only output with final reported counts", () => {
    const meter = makeThroughputMeter();
    meter.start(0);
    meter.output(400);
    meter.finish(1_000, 500);
    expect(meter.rate(1_000)).toEqual({ kind: "completed", tokensPerSecond: 500 });
    meter.start(5_000);
    meter.finish(9_000, 500);
    expect(meter.rate(9_000)).toEqual({ kind: "completed", tokensPerSecond: 200 });
  });

  it("weights completed samples by their own durations and excludes inter-call/tool time", () => {
    const meter = makeThroughputMeter();
    meter.start(0);
    meter.finish(1_000, 100);
    expect(meter.rate(90_000)).toEqual({ kind: "completed", tokensPerSecond: 100 });
    meter.start(90_000);
    meter.finish(92_000, 300);
    expect(meter.rate(200_000)?.tokensPerSecond).toBeCloseTo(400 / 3);
  });

  it("never mixes a current estimate or an incomplete call into the completed average", () => {
    const meter = makeThroughputMeter();
    meter.start(0);
    meter.finish(1_000, 100);
    meter.start(2_000);
    expect(meter.rate(3_000)).toEqual({ kind: "completed", tokensPerSecond: 100 });
    meter.output(8_000);
    expect(meter.rate(4_000)).toEqual({ kind: "live", tokensPerSecond: 1_000 });
    meter.finish(4_000, undefined);
    expect(meter.rate(4_000)).toEqual({ kind: "completed", tokensPerSecond: 100 });
  });

  it("omits unknown, zero and invalid usage along with their durations", () => {
    const meter = makeThroughputMeter();
    meter.start(0);
    meter.finish(1_000, 100);
    for (const usage of [undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_VALUE]) {
      meter.start(2_000);
      meter.finish(100_000, usage);
      expect(meter.rate(100_000)).toEqual({ kind: "completed", tokensPerSecond: 100 });
    }
  });

  it("discards zero, negative and invalid durations rather than storing unmatched tokens", () => {
    const meter = makeThroughputMeter();
    for (const end of [1_000, 0, NaN, Infinity]) {
      meter.start(1_000);
      meter.finish(end, 1_000);
    }
    meter.start(2_000);
    meter.finish(3_000, 100);
    expect(meter.rate(3_000)).toEqual({ kind: "completed", tokensPerSecond: 100 });
  });

  it("settles a call once and discards unfinished predecessors at the next start", () => {
    const meter = makeThroughputMeter();
    meter.start(0);
    meter.output(4_000);
    meter.start(2_000);
    meter.output(40);
    expect(meter.rate(3_000)).toEqual({ kind: "live", tokensPerSecond: 10 });
    meter.finish(3_000, 100);
    meter.finish(100_000, 10_000);
    expect(meter.rate(100_000)).toEqual({ kind: "completed", tokensPerSecond: 100 });
  });

  it("includes streaming silence and clears every sample at a run reset", () => {
    const meter = makeThroughputMeter();
    meter.start(0);
    meter.output(400);
    expect(meter.rate(1_000)?.tokensPerSecond).toBe(100);
    expect(meter.rate(5_000)?.tokensPerSecond).toBe(20);
    meter.finish(5_000, 100);
    meter.reset();
    expect(meter.rate(6_000)).toBeUndefined();
    meter.finish(7_000, 500);
    expect(meter.rate(7_000)).toBeUndefined();
  });

  it("preserves the last complete aggregate if adding a sample would overflow", () => {
    const meter = makeThroughputMeter();
    meter.start(0);
    meter.finish(1_000, Number.MAX_SAFE_INTEGER);
    meter.start(2_000);
    meter.finish(3_000, 1);
    expect(meter.rate(3_000)).toEqual({
      kind: "completed",
      tokensPerSecond: Number.MAX_SAFE_INTEGER,
    });
  });
});
