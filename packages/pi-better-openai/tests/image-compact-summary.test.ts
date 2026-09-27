import { compactIssueSeverity } from "pi-code-previews";
import { issueMessageStyleProblems } from "pi-code-previews/testing";
import { describe, expect, it } from "vitest";
import { imageCompactSummary } from "../src/image/compact-summary.ts";

type Input = Parameters<typeof imageCompactSummary>[0];
const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
const input = (status = "completed"): Input => ({
  phase: "settled",
  args: { prompt: "An otter", action: "generate" },
  // SAFETY: The provider reads only isError from Pi's renderer context.
  context: { isError: false } as Input["context"],
  result: {
    content: [{ type: "text", text: "Generated image" }, image],
    details: {
      id: "image-1",
      status,
      prompt: "An otter",
      mimeType: "image/png",
      model: "model",
      action: "generate",
      outputFormat: "png",
      savedPath: "/project/output.png",
    },
  },
});

describe("image compact summary", () => {
  it("preserves a validated cancellation despite host isError", () => {
    const call = input("cancelled");
    call.context.isError = true;
    expect(imageCompactSummary(call)?.outcome).toBe("cancelled");
  });
  it.each(["pending", "running"] as const)("reports %s without claiming success", (phase) => {
    const summary = imageCompactSummary({ ...input(), phase, result: undefined });
    expect(summary?.outcome).toBeUndefined();
    expect(summary?.action).toBe("generate");
    expect(summary?.metadata).toBeUndefined();
  });

  it.each([
    ["completed", "success", undefined],
    ["failed", "error", "error"],
    ["cancelled", "cancelled", undefined],
    ["incomplete", "uncertain", "warning"],
    ["in_progress", "uncertain", "warning"],
  ])("classifies %s from domain details", (status, outcome, severity) => {
    const call = input(status);
    const before = structuredClone(call.result);
    const summary = imageCompactSummary(call);
    expect(summary?.outcome).toBe(outcome);
    expect(compactIssueSeverity(summary?.issues)).toBe(severity);
    expect(summary?.subject).toContain("/project/output.png");
    // Expanded content states the saved path; issues do not repeat it.
    expect(JSON.stringify(summary?.issues ?? [])).not.toContain("/project/output.png");
    expect(call.result).toEqual(before);
    expect(call.result?.content[1]).toBe(image);
  });

  it("preserves literal saved paths rather than shortening or normalizing them", () => {
    const call = input();
    const savedPath = "/project/" + "long directory/".repeat(12) + "two  spaces.png";
    // SAFETY: input() supplies a plain details object for this completed image fixture.
    call.result!.details = { ...(call.result!.details as object), savedPath };
    const before = structuredClone(call.result);
    expect(imageCompactSummary(call)?.subject).toBe(savedPath);
    expect(call.result).toEqual(before);
  });

  it("declines missing, malformed and unknown details", () => {
    // SAFETY: The fixture above always supplies a plain details object.
    const validDetails = input().result!.details as object;
    for (const details of [undefined, {}, { ...validDetails, savedPath: 42 }]) {
      const call = input();
      call.result!.details = details;
      expect(imageCompactSummary(call)).toBeUndefined();
    }
    expect(imageCompactSummary(input("unknown"))).toBeUndefined();
    const call = input();
    call.result!.content = [{ type: "text", text: "Generated image" }];
    expect(imageCompactSummary(call)).toBeUndefined();
  });

  it("classifies text-only errors by their first line and declines attachment-bearing errors", () => {
    const call = input();
    call.context.isError = true;
    const text = "Save failed.\nOutput may exist; inspect the destination before retrying.";
    call.result = { content: [{ type: "text", text }], details: undefined };
    const summary = imageCompactSummary(call);
    expect(summary?.outcome).toBe("error");
    expect(summary?.issues).toEqual([
      expect.objectContaining({ severity: "error", message: "Save failed" }),
    ]);
    for (const issue of summary?.issues ?? [])
      expect(issueMessageStyleProblems(issue.message)).toEqual([]);
    call.result.content.push(image);
    expect(imageCompactSummary(call)).toBeUndefined();
    expect(call.result.content[1]).toBe(image);
  });
});
