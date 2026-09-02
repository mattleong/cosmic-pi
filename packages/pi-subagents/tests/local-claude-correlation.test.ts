import { describe, expect, it } from "vitest";
import {
  isInternalReplayOrigin,
  makeClaudeResultCorrelation,
  zeroUsageComponents,
} from "../src/backend/local-claude-correlation.ts";

describe("local Claude result correlation", () => {
  it("separates internal notifications from externally qualified task deliveries", () => {
    expect(isInternalReplayOrigin("task-notification", undefined)).toBe(true);
    expect(isInternalReplayOrigin("auto-continuation", undefined)).toBe(true);
    expect(isInternalReplayOrigin("task-notification", "peer-send-message")).toBe(false);
    expect(isInternalReplayOrigin("task-notification", "scheduled-trigger")).toBe(false);
  });

  it("does not let a UUID-less ordinary result consume synthetic ownership", () => {
    const correlation = makeClaudeResultCorrelation();
    correlation.register({ uuid: "synthetic", kind: "synthetic", epoch: 2 }, zeroUsageComponents);
    correlation.register({ uuid: "assignment", kind: "assignment", epoch: 2 }, zeroUsageComponents);

    expect(correlation.take(undefined, undefined, undefined)).toMatchObject({
      uuid: "assignment",
      kind: "assignment",
    });
    expect(correlation.take(undefined, "task-notification", undefined)).toMatchObject({
      uuid: "synthetic",
      kind: "synthetic",
    });
  });
});
