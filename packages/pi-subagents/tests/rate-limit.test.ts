import { describe, expect, it } from "vitest";
import type { ChildRateLimitEvent } from "../src/run/child-agent.ts";
import { rateLimitWindowKey } from "../src/run/rate-limit.ts";

const event = (resetsAt?: number): ChildRateLimitEvent => ({
  type: "rate_limit",
  status: "rejected",
  rateLimitType: "five_hour",
  ...(resetsAt === undefined ? {} : { resetsAt }),
});

describe("rate-limit window identity", () => {
  it("uses reset timestamps when available and turn identity otherwise", () => {
    expect(rateLimitWindowKey(event(123), 4)).toBe("five_hour:123");
    expect(rateLimitWindowKey(event(), 4)).toBe("five_hour:unknown-turn-4");
    expect(rateLimitWindowKey(event(), 5)).toBe("five_hour:unknown-turn-5");
  });
});
