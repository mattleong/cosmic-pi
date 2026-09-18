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
  it.each(["pending", "running"] as const)("reports %s without claiming success", (phase) => {
    const summary = imageCompactSummary({ ...input(), phase, result: undefined });
    expect(summary?.outcome).toBeUndefined();
    expect(summary?.action).toBe("generate");
    expect(summary?.metadata).toBeUndefined();
  });

  it.each([
    ["completed", "success"],
    ["failed", "error"],
    ["cancelled", "cancelled"],
    ["incomplete", "uncertain"],
    ["in_progress", "uncertain"],
  ])("classifies %s from domain details", (status, outcome) => {
    const call = input(status);
    const before = structuredClone(call.result);
    const summary = imageCompactSummary(call);
    expect(summary?.outcome).toBe(outcome);
    if (status === "completed") {
      expect(summary?.notices).toBeUndefined();
      expect(summary?.subject).toContain("/project/output.png");
    } else {
      expect(summary?.notices).toContainEqual(
        expect.objectContaining({
          kind: "recovery",
          text: "Saved: /project/output.png",
        }),
      );
    }
    expect(call.result).toEqual(before);
    expect(call.result?.content[1]).toBe(image);
    expect(summary?.failure).toBeUndefined();
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

  it("owns complete text errors without hiding recovery text", () => {
    const call = input();
    call.context.isError = true;
    const text = "Save failed.\nOutput may exist; inspect the destination before retrying.";
    call.result = { content: [{ type: "text", text }], details: undefined };
    expect(imageCompactSummary(call)?.failure).toEqual({ cause: text, details: text });
    expect(imageCompactSummary(call)?.issues).toMatchObject({
      coverage: "unknown",
      entries: [{ cause: text }],
    });
    call.result.content.push(image);
    expect(imageCompactSummary(call)).toBeUndefined();
    expect(call.result.content[1]).toBe(image);
  });
});
