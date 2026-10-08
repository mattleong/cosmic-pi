import { expect, test } from "vitest";
import { planCompactPresentation } from "../../src/tools/compact-presentation";
import { compactStatus, type CompactSummary } from "../../src/tools/compact-summary";

const heading = { subject: "full/target.ts", compactSubject: "target.ts", action: "scan" };
const plan = (
  summary: CompactSummary | undefined,
  options: {
    isError?: boolean;
    errorText?: string;
    phase?: "pending" | "running" | "settled";
  } = {},
) =>
  planCompactPresentation({
    summary,
    heading,
    phase: options.phase ?? "settled",
    isError: options.isError ?? false,
    ...(options.errorText !== undefined && { errorText: options.errorText }),
  });

test("a usable summary preserves its values and reconciles Pi errors", () => {
  const summary: CompactSummary = { subject: "target", outcome: "success", counters: ["3 lines"] };
  const planned = plan(summary);
  expect(planned.summary).toEqual(summary);
  const reconciled = plan(summary, { isError: true, errorText: "Rejected\nstack" });
  expect(reconciled.summary?.outcome).toBe("error");
});

test("settled results without a usable summary never claim success", () => {
  // Provider output crosses a runtime boundary; malformed values arrive untyped.
  const summaries: Array<CompactSummary | undefined> = JSON.parse(
    JSON.stringify([
      null,
      { subject: "missing outcome" },
      { subject: "malformed", outcome: "success", issues: [{ severity: "fatal" }] },
    ]),
  );
  for (const summary of [undefined, ...summaries.slice(1)]) {
    const planned = plan(summary);
    expect(planned.summary).toBeUndefined();
    expect(planned.collapsedSummary).toMatchObject({ ...heading, outcome: "uncertain" });
    expect(planned.collapsedSummary.issues ?? []).toEqual([]);
    expect(planned.collapsedSummary.metadata?.length).toBe(1);
    expect(compactStatus("settled", planned.collapsedSummary)).toBe("uncertain");
  }
});

test("an unsummarised Pi error explains itself with the first line of its text", () => {
  const planned = plan(undefined, {
    isError: true,
    errorText: "\nENOENT: missing file\n    at internal stack",
  });
  expect(planned.summary).toBeUndefined();
  expect(planned.collapsedSummary).toMatchObject({ ...heading, outcome: "error" });
  expect(planned.collapsedSummary.issues).toEqual([
    expect.objectContaining({ severity: "error", message: "ENOENT: missing file" }),
  ]);
  const blank = plan(undefined, { isError: true, errorText: " \n " }).collapsedSummary;
  expect(blank.issues).toHaveLength(1);
  expect(blank.issues?.[0]?.message.trim()).not.toBe("");
  expect(plan(undefined, { isError: true }).collapsedSummary.issues).toHaveLength(1);
});

test("live calls without a summary show only the argument heading", () => {
  for (const phase of ["pending", "running"] as const) {
    const planned = plan(undefined, { phase, isError: true, errorText: "not settled" });
    expect(planned.summary).toBeUndefined();
    expect(planned.collapsedSummary).toEqual(heading);
    expect(compactStatus(phase, planned.collapsedSummary)).toBe(phase);
  }
  // Only heading fields are borrowed; stale counters or issues never leak into the fallback.
  const stale: CompactSummary = {
    subject: "target",
    showTiming: true,
    counters: ["stale"],
    issues: [{ severity: "error", code: "x", message: "stale" }],
  };
  const borrowed = planCompactPresentation({
    summary: undefined,
    phase: "settled",
    isError: false,
    heading: stale,
  }).collapsedSummary;
  expect(borrowed).toMatchObject({ subject: "target", showTiming: true, outcome: "uncertain" });
  expect(JSON.stringify(borrowed)).not.toContain("stale");
  expect(
    planCompactPresentation({ summary: undefined, phase: "running", isError: false })
      .collapsedSummary,
  ).toEqual({ subject: "" });
});
