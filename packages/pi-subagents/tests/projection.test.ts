import { describe, expect, it } from "vitest";
import type { SubagentProjection, SubagentRunState, SubagentRunView } from "../src/run/model.ts";
import { fleetStatus } from "../src/run/projection.ts";

const projection = (...states: ReadonlyArray<SubagentRunState>): SubagentProjection => ({
  revision: 1,
  runs: states.map((state) => ({ state }) as SubagentRunView),
});

describe("subagent footer projection", () => {
  it("uses natural singular and plural status text", () => {
    expect(fleetStatus(projection("running"))).toBe("1 working");
    expect(fleetStatus(projection("running", "starting", "waiting_for_parent"))).toBe(
      "2 working · 1 awaiting reply",
    );
    expect(fleetStatus(projection("waiting_for_parent", "waiting_for_parent"))).toBe(
      "2 awaiting replies",
    );
  });

  it("keeps retained reported resources visible without calling their assignment unfinished", () => {
    expect(fleetStatus(projection("reported"))).toBe("1 retained");
    expect(fleetStatus(projection("paused", "reported"))).toBe("1 paused · 1 retained");
  });

  it("hides the footer status when no subagents are active", () => {
    expect(fleetStatus(projection("completed", "failed", "stopped"))).toBeUndefined();
  });
});
