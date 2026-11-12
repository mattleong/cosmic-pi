import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { compactIssueSeverity } from "pi-code-previews";
import { issueMessageStyleProblems, renderContextFixture } from "pi-code-previews/testing";
import { describe, expect, it } from "vitest";
import { imageCompactSummaryFor, restatesImageFailure } from "../src/image/compact-summary.ts";

const imageCompactSummary = imageCompactSummaryFor("compact");
import type { CodexImageDetails } from "../src/image/types.ts";
import { pngPart } from "./image-fixtures.ts";

type Input = Parameters<typeof imageCompactSummary>[0];
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
  result: {
    content: [{ type: "text", text: "Generated image" }, pngPart],
    details: record(status),
  },
});
const styleProblems = (summary: ReturnType<typeof imageCompactSummary>) =>
  Arr.flatMap(summary?.issues ?? [], (issue) => issueMessageStyleProblems(issue.message));

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
    expect(call.result?.content[1]).toBe(pngPart);
  });
});

describe("image generation failures", () => {
  it("names the provider's cause collapsed and keeps the recovery step for expansion", () => {
    const call = input();
    const summary = imageCompactSummary({
      ...call,
      context: renderContextFixture({ isError: true }),
      result: {
        content: [
          {
            type: "text",
            text: "Image generation failed: Your request was rejected by the safety system (HTTP 400).",
          },
        ],
        details: {},
      },
    });
    const [issue] = summary?.issues ?? [];
    expect(summary?.outcome).toBe("error");
    expect(issue?.message).toContain("rejected by the safety system");
    expect(issue?.message).toContain("HTTP 400");
    // The row's ✗ already says generation failed; the issue states only why.
    expect(issue?.message).not.toContain("Image generation failed");
    expect(issue?.detail).toBeDefined();
    expect(styleProblems(summary)).toEqual([]);
  });

  it("states a failed record's missing cause without restating that it failed", () => {
    const [issue] = imageCompactSummary(input("failed"))?.issues ?? [];
    expect(issue?.message).not.toContain("Image generation failed");
    expect(issue?.detail).toBeDefined();
  });

  it("hides raw failure text that says only its issue's cause, and keeps anything more", () => {
    expect(restatesImageFailure("Image generation failed: OpenAI gave no reason.")).toBe(true);
    expect(
      restatesImageFailure(
        "Image generation failed: OpenAI gave no reason.\nrequest id req_123 at stage upload",
      ),
    ).toBe(false);
  });
});

describe("image result notes", () => {
  it("keeps a completed image successful while surfacing its note", () => {
    const call = input();
    const note = "Codex returned webp instead of the requested png";
    const summary = imageCompactSummary({
      ...call,
      result: { content: [pngPart], details: { ...record("completed"), note } },
    });
    expect(summary?.outcome).toBe("success");
    expect(summary?.issues).toEqual([expect.objectContaining({ severity: "info" })]);
    expect(summary?.issues?.[0]?.message).toContain("webp");
    expect(styleProblems(summary)).toEqual([]);
  });
});

describe("image expansion", () => {
  // Expansion always shows the complete prompt; settled rows add the image's facts or recovery.
  it.each(["pending", "running"] as const)("offers the prompt while %s", (phase) => {
    const summary = imageCompactSummary({ ...input(), phase, result: undefined });
    expect(summary?.expandLabel).toEqual(expect.any(String));
  });

  // A compact heading may cut the prompt, so the shell drops `prompt` only where it showed whole.
  it("marks a compact request's prompt affordance as revealing only the subject", () => {
    const pending = (args: Input["args"]) =>
      imageCompactSummary({ ...input(), phase: "running", args, result: undefined });
    const plain = pending({ prompt: "An otter", action: "generate" });
    expect(plain?.expandLabel).toEqual(expect.any(String));
    expect(plain?.expandsSubjectOnly).toBe(true);
    for (const args of [
      { prompt: "An otter", action: "generate", save: "none" },
      { prompt: "An otter\nat dawn" },
      { prompt: Str.repeat(30)("otter ") },
    ] satisfies Input["args"][])
      expect(pending(args)?.expandsSubjectOnly).toBeUndefined();
  });

  // A preview heading wraps, so it already shows a short prompt whole.
  it("offers a pending preview row's expansion only for what its heading leaves out", () => {
    const preview = imageCompactSummaryFor("preview");
    const pending = (args: Input["args"]) =>
      preview({ ...input(), phase: "running", args, result: undefined })?.expandLabel;
    expect(pending({ prompt: "An otter", action: "generate" })).toBe(false);
    expect(pending({ prompt: "An otter", action: "generate", save: "none" })).toEqual(
      expect.any(String),
    );
    expect(pending({ prompt: "An otter\nat dawn" })).toEqual(expect.any(String));
    expect(pending({ prompt: Str.repeat(30)("otter ") })).toEqual(expect.any(String));
  });

  it("offers expansion for settled images and failures", () => {
    const failed = imageCompactSummary({
      ...input(),
      context: renderContextFixture({ isError: true }),
      result: {
        content: [{ type: "text", text: "Invalid OpenAI image parameters." }],
        details: {},
      },
    });
    for (const summary of [imageCompactSummary(input()), failed])
      expect(summary?.expandLabel).toEqual(expect.any(String));
  });

  it("names a settled prompt its heading can't show exactly as what expansion reveals", () => {
    const settled = (prompt: string) =>
      imageCompactSummary({ ...input(), args: { prompt, action: "generate" } })?.expandLabel;
    expect(settled(Str.repeat(30)("otter "))).not.toBe(settled("An otter"));
    expect(settled("An otter\nat dawn")).toBe(settled(Str.repeat(30)("otter ")));
  });
});
