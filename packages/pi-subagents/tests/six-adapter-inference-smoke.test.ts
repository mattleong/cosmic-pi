// Paid-inference smoke DESIGN gate. Normal CI never enables this suite.
// @effect-diagnostics effect/processEnv:off
import { describe, expect, it } from "vitest";

const enabled = process.env.PI_SUBAGENTS_REAL_INFERENCE_SMOKE === "1";
const acknowledged = process.env.PI_SUBAGENTS_REAL_INFERENCE_ACK === "paid-and-destructive";
/**
 * This gated manifest is intentionally not a hidden paid runner. The manual Pi-host harness must:
 * 1. configure six explicit read-only profiles, one per matrix row, with fixed native models;
 * 2. start one self-contained task asking for a unique supervisor report marker;
 * 3. await and claim exactly one generation per run (including Herdr retained follow-up when used);
 * 4. verify question/reply once on each adapter and no raw-final-text completion;
 * 5. stop every run and independently inspect Herdr/private writer state before recovery.
 */
describe.skipIf(!enabled)("six-adapter paid inference smoke design", () => {
  it("requires explicit cost/destructive acknowledgement", () => {
    expect(acknowledged).toBe(true);
  });
});
