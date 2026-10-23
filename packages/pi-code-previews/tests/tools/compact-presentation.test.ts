import { expect, test } from "vitest";
import { planCompactPresentation } from "../../src/tools/compact-presentation";
import { compactStatus, type CompactSummary } from "../../src/tools/compact-summary";
import { isSafeCompactSummary } from "../../src/tools/compact-summary-schema";
import * as Str from "effect/String";
import * as Option from "effect/Option";

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

test("settled results without a usable summary never claim success", () => {
  const candidates = structuredClone([
    undefined,
    { subject: "missing outcome" },
    { subject: "malformed", outcome: "success", issues: [{ severity: "fatal" }] },
  ]);
  for (const candidate of candidates) {
    const planned = plan(isSafeCompactSummary(candidate) ? candidate : undefined);
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
  expect(
    Option.fromUndefinedOr(blank.issues?.[0]).pipe(
      Option.map((issue) => Str.trim(issue.message)),
      Option.getOrUndefined,
    ),
  ).not.toBe("");
  expect(plan(undefined, { isError: true }).collapsedSummary.issues).toHaveLength(1);
});
