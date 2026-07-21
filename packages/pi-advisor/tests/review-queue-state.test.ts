import { describe, expect, test } from "vitest";
import {
  acceptSteering,
  attemptSteering,
  beginCheckpoint,
  cancelQueuedCheckpoint,
  disposeReviewQueue,
  enqueueCheckpoint,
  initialReviewQueueState,
  resetReviewQueue,
  settleCheckpoint,
} from "../src/review-queue-state.ts";

describe("review queue state transitions", () => {
  test("tracks one active checkpoint and one authoritative processed cursor", () => {
    const queued = enqueueCheckpoint(enqueueCheckpoint(initialReviewQueueState()));
    const active = beginCheckpoint(queued, "one", 4, 0);
    expect(active.pendingCount).toBe(1);
    expect(active.active).toMatchObject({ checkpointId: "one", target: 4 });

    const attempted = attemptSteering(active, "one", 7);
    const accepted = acceptSteering(attempted, "one", 6);
    expect(accepted.active?.steeringAttemptedThrough).toBe(7);
    expect(accepted.active?.steeredThrough).toBe(6);

    const settled = settleCheckpoint(accepted, "one", 4);
    expect(settled.active).toBeUndefined();
    expect(settled.processedThrough).toBe(4);
    expect(cancelQueuedCheckpoint(settled).pendingCount).toBe(0);
  });

  test("reset and dispose invalidate the epoch and clear progress atomically", () => {
    const active = beginCheckpoint(enqueueCheckpoint(initialReviewQueueState()), "one", 3, 0);
    const reset = resetReviewQueue(settleCheckpoint(active, "one", 3));
    expect(reset).toEqual({
      epoch: 1,
      disposed: false,
      pendingCount: 0,
      processedThrough: 0,
      active: undefined,
    });
    expect(disposeReviewQueue(reset)).toMatchObject({ epoch: 2, disposed: true });
  });
});
