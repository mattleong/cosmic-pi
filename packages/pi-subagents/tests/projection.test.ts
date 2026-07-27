import { describe, expect, it } from "vitest";
import type { SubagentProjection, SubagentRunState, SubagentRunView } from "../src/run/model.ts";
import { fleetStatus } from "../src/run/projection.ts";

const projection = (...states: ReadonlyArray<SubagentRunState>): SubagentProjection => ({
  revision: 1,
  runs: states.map((state) => ({ state }) as SubagentRunView),
});

describe("subagent footer projection", () => {
  it("uses natural singular and plural status text", () => {
    expect(fleetStatus(projection("running"))).toBe("1 subagent active");
    expect(fleetStatus(projection("running", "starting", "waiting_for_parent"))).toBe(
      "3 subagents active · 1 awaiting reply",
    );
    expect(fleetStatus(projection("waiting_for_parent", "waiting_for_parent"))).toBe(
      "2 subagents active · 2 awaiting replies",
    );
  });

  it("hides the footer status when no subagents are active", () => {
    expect(fleetStatus(projection("completed", "failed", "stopped"))).toBeUndefined();
  });
});
