import { expect, it } from "vitest";
import { issueMessageStyleProblems } from "pi-code-previews/testing";
import { runAttention, runCleanupAttention } from "../../src/run/attention.ts";
import { compactRunIssues } from "../../src/tools/compact-run-issues.ts";
import { compactToolDetails } from "../../src/tools/details.ts";
import { attentionRecoveryText } from "../../src/tools/format.ts";
import { containedWriter, view } from "../fixtures/run-view.ts";

const question = { requestId: "q", message: "May I edit db/0007.sql?" };

it("keeps cleanup recovery independent of claims and never stops healthy pool peers", () => {
  const run = view({
    state: "completed",
    cleanup: { disposition: "quarantined", recovery: "stop" },
    writerCleanupQuarantined: true,
  });
  expect(runAttention(run)).toBeUndefined();
  expect(runCleanupAttention(run)).toBe("quarantined");
  expect(attentionRecoveryText([run])).toMatch(/action: "stop"/);
  expect(attentionRecoveryText([run])).not.toContain("resume_admission");
  const contained = containedWriter({ ...run, state: "completed", writeIntent: "writer" });
  expect(runAttention(contained)?.kind).toBe("containment");
  const recovery = attentionRecoveryText([contained]);
  expect(recovery).toMatch(/claim containment/i);
  expect(recovery).toMatch(/cleanup/i);
  expect(recovery).not.toContain("resume_admission");
  const manual = attentionRecoveryText([
    { ...run, cleanup: { disposition: "quarantined", recovery: "manual" } },
  ]);
  expect(manual).toMatch(/manual/i);
  expect(manual).not.toMatch(/action: "stop"|action: "retry"|resume_admission/);
  const peer = {
    ...run,
    state: "running" as const,
    cleanup: { disposition: "confirmed" as const },
  };
  expect(runCleanupAttention(peer)).toBe("pool-quarantined");
  const peerRecovery = attentionRecoveryText([peer]);
  expect(peerRecovery).not.toMatch(/action: "stop"|resume_admission/);
  expect(peerRecovery).toMatch(/do not stop healthy peers/i);
  expect(runCleanupAttention(view())).toBeUndefined();
  for (const candidate of [
    run,
    contained,
    peer,
    { ...run, cleanup: { disposition: "pending" as const } },
  ]) {
    const details = compactToolDetails({ action: "status", runs: [candidate] });
    const issues = compactRunIssues("cards" in details ? details.cards : []);
    expect(
      issues.flatMap((issue) =>
        issueMessageStyleProblems(issue.message, { forbidden: [candidate.id] }),
      ),
    ).toEqual([]);
  }
});

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
    const details = compactToolDetails({ action: "status", runs: [run] });
    const cards = "cards" in details ? details.cards : [];
    const lines = compactRunIssues(cards).filter((issue) => issue.severity === "warning");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.message.startsWith(run.name)).toBe(true);
    expect(attentionRecoveryText([run])).toContain(run.id);
  }
});
