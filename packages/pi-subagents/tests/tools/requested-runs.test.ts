import * as Arr from "effect/Array";
import { stripAnsi } from "pi-cosmic-core";
import { plainTheme } from "pi-cosmic-core/testing";
import { describe, expect, it } from "vitest";
import { decodeOutcomeDetails } from "../../src/tools/details-decode.ts";
import { compactToolDetails } from "../../src/tools/details.ts";
import { rememberRunNames, renderRequestedRuns } from "../../src/tools/render.ts";
import { view } from "./fixtures/tool-harness.ts";

const requested = (ids: ReadonlyArray<string>, toolCallId: string) =>
  stripAnsi(
    Arr.join(
      renderRequestedRuns(
        ids,
        { until: "all_finished" },
        "agent_lifecycle",
        plainTheme,
        toolCallId,
      ).render(100),
      "\n",
    ),
  );

describe("requested runs beside their result", () => {
  it("names the runs the result resolved and keeps unknown ids as typed", () => {
    const details = compactToolDetails({
      action: "stop",
      runs: [view({ id: "agent-1", name: "auth-review", state: "stopped" })],
    });
    expect(requested(["agent-1", "agent-12"], "call-1")).toContain("agent-1");
    rememberRunNames("call-1", decodeOutcomeDetails(details));
    const named = requested(["agent-1", "agent-12"], "call-1");
    expect(named).toContain("auth-review");
    expect(named).not.toContain("agent-1,");
    expect(named).toContain("agent-12");
    // Another row's result never renames this one.
    expect(requested(["agent-1"], "call-2")).toContain("agent-1");
  });
});
