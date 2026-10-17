import { expect, it } from "vitest";
import { runAttention } from "../../src/run/attention.ts";
import { containedWriter, view } from "../fixtures/run-view.ts";

const question = { requestId: "q", message: "May I edit db/0007.sql?" };

it("resolves one attention state per run by precedence", () => {
  for (const [run, kind] of [
    [containedWriter({ state: "paused" }), "containment"],
    [
      view({
        writeIntent: "writer",
        writeClaims: ["a"],
        writeAdmissionPaused: true,
        state: "paused",
      }),
      "admission-paused",
    ],
    [view({ state: "paused" }), "paused"],
    [view({ state: "waiting_for_parent", question }), "question"],
    [view({ state: "waiting_for_parent" }), "question-unavailable"],
    [view({ state: "running" }), undefined],
  ] as const)
    expect(runAttention(run)?.kind).toBe(kind);
});
