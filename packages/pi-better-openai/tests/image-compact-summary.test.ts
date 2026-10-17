import { compactIssueSeverity } from "pi-code-previews";
import { issueMessageStyleProblems, renderContextFixture } from "pi-code-previews/testing";
import { describe, expect, it } from "vitest";
import { imageCompactSummary } from "../src/image/compact-summary.ts";
import type { CodexImageDetails } from "../src/image/types.ts";

type Input = Parameters<typeof imageCompactSummary>[0];
const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
const record = (status: string): CodexImageDetails => ({
  id: "image-1",
  status,
  prompt: "An otter",
  mimeType: "image/png",
  model: "model",
  action: "generate",
  outputFormat: "png",
  savedPath: "/project/generated/otter-image-1.png",
});
const input = (status = "completed", expanded = false): Input => ({
  phase: "settled",
  args: { prompt: "An otter", action: "generate" },
  context: renderContextFixture({ expanded }),
  result: { content: [{ type: "text", text: "Generated image" }, image], details: record(status) },
});
const styleProblems = (summary: ReturnType<typeof imageCompactSummary>) =>
  (summary?.issues ?? []).flatMap((issue) => issueMessageStyleProblems(issue.message));

describe("image compact summary", () => {
  it.each([
    ["failed", "error", "error"],
    ["incomplete", "uncertain", "warning"],
  ])("classifies %s from domain details", (status, outcome, severity) => {
    const call = input(status);
    const before = structuredClone(call.result);
    const summary = imageCompactSummary(call);
    expect(summary?.outcome).toBe(outcome);
    expect(compactIssueSeverity(summary?.issues)).toBe(severity);
    expect(styleProblems(summary)).toEqual([]);
    expect(JSON.stringify(summary?.issues ?? [])).not.toContain("otter-image-1.png");
    expect(call.result).toEqual(before);
    expect(call.result?.content[1]).toBe(image);
  });
});
