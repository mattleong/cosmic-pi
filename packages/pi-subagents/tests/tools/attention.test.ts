import { expect, it } from "vitest";
import { runAttention } from "../../src/tools/attention.ts";
import { runAttentionIssues } from "../../src/tools/compact-run-issues.ts";
import { makeCompactToolDetails } from "../../src/tools/details.ts";
import { attentionRecoveryText } from "../../src/tools/format.ts";
import { containedWriter, view } from "../fixtures/run-view.ts";

const question = { requestId: "q", message: "May I edit db/0007.sql?", createdAt: 1 };

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

it("gives each attention state one issue line and agent steps for the same run", () => {
  for (const run of [
    containedWriter({ state: "running" }),
    view({ state: "paused" }),
    view({ state: "waiting_for_parent", question }),
  ]) {
    const details = makeCompactToolDetails({ action: "status", runs: [run] });
    const cards = "cards" in details ? details.cards : [];
    const lines = runAttentionIssues(cards).filter((issue) => issue.severity === "warning");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.message.startsWith(run.name)).toBe(true);
    expect(attentionRecoveryText([run])).toContain(run.id);
  }
});
