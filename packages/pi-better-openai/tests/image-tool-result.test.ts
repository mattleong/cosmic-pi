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
});
