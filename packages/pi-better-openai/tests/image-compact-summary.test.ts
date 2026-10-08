import { compactIssueSeverity } from "pi-code-previews";
import { issueMessageStyleProblems } from "pi-code-previews/testing";
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
  // SAFETY: The provider reads only isError and expanded from Pi's renderer context.
  context: { isError: false, expanded } as Input["context"],
  result: { content: [{ type: "text", text: "Generated image" }, image], details: record(status) },
});
const errorInput = <Details>(text: string, details: Details): Input => {
  const call = input();
  call.context.isError = true;
  call.result = { content: [{ type: "text", text }], details };
  return call;
};
const styleProblems = (summary: ReturnType<typeof imageCompactSummary>) =>
  (summary?.issues ?? []).flatMap((issue) => issueMessageStyleProblems(issue.message));

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
    expect(styleProblems(summary)).toEqual([]);
    // Expanded content states the saved path; issues do not repeat it.
    expect(JSON.stringify(summary?.issues ?? [])).not.toContain("otter-image-1.png");
    expect(call.result).toEqual(before);
    expect(call.result?.content[1]).toBe(image);
  });

  it("keeps the prompt as the subject and names the saved file only while collapsed", () => {
    const collapsed = imageCompactSummary(input());
    expect(collapsed?.subject).toBe("An otter");
    expect(collapsed?.metadata).toEqual(["otter-image-1.png"]);
    const expanded = imageCompactSummary(input("completed", true));
    expect(expanded?.subject).toBe("An otter");
    expect(expanded?.metadata ?? []).not.toContain("otter-image-1.png");
  });

  it("warns rather than confirming success when a completed record has no image", () => {
    const call = input();
    call.result!.content = [{ type: "text", text: "Generated image" }];
    const summary = imageCompactSummary(call);
    expect(summary?.outcome).toBe("uncertain");
    expect(compactIssueSeverity(summary?.issues)).toBe("warning");
    expect(styleProblems(summary)).toEqual([]);
  });

  it("declines missing, malformed and unknown details", () => {
    const validDetails = record("completed");
    for (const details of [undefined, {}, { ...validDetails, savedPath: 42 }]) {
      const call = input();
      call.result!.details = details;
      expect(imageCompactSummary(call)).toBeUndefined();
    }
    expect(imageCompactSummary(input("unknown"))).toBeUndefined();
  });

  it.each([
    ["without details", undefined],
    ["with Pi's empty error details", {}],
  ])("classifies text-only errors %s by their first line", (_label, details) => {
    const text = "Save failed.\nOutput may exist; inspect the destination before retrying.";
    const summary = imageCompactSummary(errorInput(text, details));
    expect(summary?.outcome).toBe("error");
    expect(summary?.issues).toEqual([
      expect.objectContaining({ severity: "error", message: "Save failed" }),
    ]);
    expect(styleProblems(summary)).toEqual([]);
  });

  it("declines attachment-bearing and detail-bearing errors", () => {
    const call = errorInput("Save failed", undefined);
    call.result!.content.push(image);
    expect(imageCompactSummary(call)).toBeUndefined();
    expect(call.result!.content[1]).toBe(image);
    expect(imageCompactSummary(errorInput("Save failed", { reason: "disk" }))).toBeUndefined();
  });

  it("names the sign-in command for missing credentials instead of quoting the provider", () => {
    const text = "Missing openai-codex OAuth credentials. Run /login openai-codex.";
    const summary = imageCompactSummary(errorInput(text, {}));
    expect(summary?.outcome).toBe("error");
    const [issue] = summary?.issues ?? [];
    expect(issue?.message).toContain("/login openai-codex");
    expect(issue?.message).not.toContain("OAuth");
    expect(styleProblems(summary)).toEqual([]);
  });
});
