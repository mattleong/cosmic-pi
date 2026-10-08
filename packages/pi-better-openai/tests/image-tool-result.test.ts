import { describe, expect, it } from "vitest";
import { imageResultText } from "../src/image/result-text.ts";
import { imageToolResult } from "../src/image/tool-result.ts";
import type { CodexImageResult } from "../src/image/types.ts";

const generated: CodexImageResult = {
  id: "generated-image",
  status: "completed",
  prompt: "  Draw a comet.\nKeep these words exactly.  ",
  revisedPrompt: "A bright comet.",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  mimeType: "image/png",
  model: "fixture-model",
  imageModel: "fixture-image-model",
  action: "generate",
  outputFormat: "png",
};

const envelope = { contract: "pi-better-openai/image", version: 1, tool: "openai_image" };

describe("image tool result projection", () => {
  for (const savedPath of [undefined, "/project/.pi/generated-images/comet.png"]) {
    it(`retains the image and exact prompt ${savedPath ? "with a saved path" : "without saving"}`, () => {
      const image = { ...generated, ...(savedPath !== undefined && { savedPath }) };
      const result = imageToolResult(image);
      const { data, mimeType, ...metadata } = image;
      const block = { type: "image", data, mimeType };
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ ...envelope, ...metadata, image: block });
      expect(result.structuredContent).not.toHaveProperty("data");
      expect(result.content).toEqual([{ type: "text", text: imageResultText(image) }, block]);
      expect(result.details).toEqual({ ...metadata, mimeType });
      expect(JSON.stringify(result.details)).not.toContain(data);
      expect(result.content[0]).not.toHaveProperty("data");
    });
  }

  it("omits absent optional metadata and never projects unowned service fields", () => {
    const { revisedPrompt: _revised, imageModel: _imageModel, ...minimal } = generated;
    const serviceResult = { ...minimal, internal: "private" };
    const result = imageToolResult(serviceResult);
    expect(result.structuredContent).not.toHaveProperty("revisedPrompt");
    expect(result.structuredContent).not.toHaveProperty("imageModel");
    expect(result.structuredContent).not.toHaveProperty("savedPath");
    expect(result.structuredContent).not.toHaveProperty("internal");
    expect(result.structuredContent).toHaveProperty("image.data", generated.data);
  });

  it("fails closed after a producer invariant breaks while retaining the image and receipt", () => {
    const malformed = {
      ...generated,
      savedPath: "/project/.pi/generated-images/comet.png",
      // SAFETY: Simulates invalid service metadata after generation and saving committed.
      outputFormat: "unexpected-format" as CodexImageResult["outputFormat"],
    };
    const result = imageToolResult(malformed);
    expect(result.isError).toBe(true);
    expect(result).not.toHaveProperty("structuredContent");
    const { data: _data, ...details } = malformed;
    expect(result.details).toEqual(details);
    expect(result.content[1]).toEqual({
      type: "image",
      data: generated.data,
      mimeType: generated.mimeType,
    });
    const first = result.content[0];
    expect(first?.type).toBe("text");
    if (first?.type !== "text") throw new Error("Missing image receipt");
    expect(first.text).toContain(imageResultText(malformed));
    expect(first.text).not.toContain("unexpected-format");
    expect(first.text).not.toContain(generated.data);
  });
});
