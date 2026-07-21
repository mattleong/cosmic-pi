import { describe, expect, it } from "vitest";
import {
  initialAdvisorApplicationState,
  recordAdvisorReceipt,
  setAdvisorSpinnerOwner,
} from "../src/advisor-application-state.ts";

describe("AdvisorApplicationState reducers", () => {
  it("coalesces receipts by request and keeps spinner ownership metadata plain", () => {
    const initial = { ...initialAdvisorApplicationState(), requestSequence: 7 };
    const first = recordAdvisorReceipt(initial, ["a"]);
    const second = recordAdvisorReceipt(first, ["a", "b"]);
    expect(second.pendingReceipt).toEqual({
      ids: ["a", "b"],
      count: 2,
      cancellationEpoch: 0,
      requestSequence: 7,
    });
    expect(setAdvisorSpinnerOwner(second, "checkpoint-1").spinner).toEqual({
      owner: "checkpoint-1",
      frame: 0,
    });
    expect(setAdvisorSpinnerOwner(second).spinner).toEqual({ frame: 0 });
  });
});
