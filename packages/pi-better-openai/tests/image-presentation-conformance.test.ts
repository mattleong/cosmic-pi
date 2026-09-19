import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Container, Image, type Component } from "@earendil-works/pi-tui";
import { createToolPresentationHarness } from "pi-code-previews/testing";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCodePreviewSettings } from "../../pi-code-previews/src/config/defaults.ts";
import { setCodePreviewSettings } from "../../pi-code-previews/src/config/state.ts";
import { registerOpenAIImage } from "../src/image/register.ts";
import { renderImageContent } from "../src/image/presentation.ts";

// SAFETY: These fixtures provide the registration and theme operations used by rendering only.
const fixture = <T>(value: T): never => value as never;
const theme: Theme = fixture({
  fg: (_: string, text: string) => text,
  bg: (_: string, text: string) => text,
  bold: (text: string) => text,
});
const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
const details = {
  id: "image-identity",
  status: "completed",
  prompt: "Full original prompt " + "long prompt ".repeat(20),
  revisedPrompt: "Full revised prompt",
  savedPath: "/project/saved image.png",
  mimeType: image.mimeType,
  model: "model",
  action: "generate",
  outputFormat: "png",
};
function register(style: "compact" | "preview") {
  setCodePreviewSettings({ ...defaultCodePreviewSettings, toolCallCollapsedStyle: style });
  const tools: ToolDefinition[] = [];
  const messages: Parameters<ExtensionAPI["registerMessageRenderer"]>[1][] = [];
  const pi: ExtensionAPI = fixture({
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    registerMessageRenderer: (
      _name: string,
      render: Parameters<ExtensionAPI["registerMessageRenderer"]>[1],
    ) => messages.push(render),
    registerCommand() {},
  });
  registerOpenAIImage(
    pi,
    () => {
      throw new Error("Rendering must not execute");
    },
    () => {
      throw new Error("Rendering must not update context");
    },
  );
  return { tool: tools[0]!, message: messages[0]! };
}
const images = (component: Component): number =>
  component instanceof Image
    ? 1
    : component instanceof Container || component instanceof Box
      ? component.children.reduce((count, child) => count + images(child), 0)
      : 0;
afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));

describe("registered image presentation", () => {
  it.each(["compact", "preview"] as const)(
    "leaves image-only and text/image attachments with Pi in %s mode",
    (style) => {
      const { tool } = register(style);
      for (const content of [
        [image],
        [{ type: "text" as const, text: "Original output" }, image],
      ]) {
        const result = { details, content };
        const before = structuredClone(result);
        const harness = createToolPresentationHarness(tool, { theme, width: 180 });
        for (const expanded of [false, true, false, true]) {
          harness.call({ prompt: details.prompt }, { expanded });
          harness.result(result, { expanded });
          const text = harness.render().join("\n");
          if (expanded && style === "compact") {
            expect(text).toContain("Full original prompt");
            expect(text).toContain(details.revisedPrompt);
            expect(text).toContain(details.savedPath);
          }
          expect(text).not.toContain(image.data);
          expect(result).toEqual(before);
        }
      }
    },
  );

  it("preserves failed edit inputs and renders the copied error once", () => {
    const harness = createToolPresentationHarness(register("compact").tool, { theme, width: 240 });
    const error = "Image request failed; inspect local output before retrying";
    harness.call(
      {
        action: "edit",
        prompt: "Full original request " + "context ".repeat(30) + "PROMPT_EVIDENCE",
        images: ["/project/original-input.png"],
        save: "custom",
        saveDir: "/project/image-target",
        outputFormat: "webp",
      },
      { expanded: true },
    );
    harness.result(
      { details: undefined, content: [{ type: "text", text: error }] },
      { expanded: true, isError: true },
    );
    const text = harness.render().join("\n");
    expect(text).toContain("PROMPT_EVIDENCE");
    expect(text).toContain("/project/original-input.png");
    expect(text).toContain("/project/image-target");
    expect(text).toContain("webp");
    expect(text.split(error)).toHaveLength(2);
  });

  it("does not let raw prose claim structured image metadata", () => {
    const raw = `Untrusted description mentions Saved: ${details.savedPath}, but is not that field.`;
    const text = renderImageContent({ details, content: [{ type: "text", text: raw }] })
      .render(240)
      .join("\n");
    expect(text).toContain(raw);
    expect(text.split(details.savedPath)).toHaveLength(3);
  });

  it("keeps malformed custom messages compact and restores raw details on expansion", () => {
    const { message } = register("compact");
    const content = [
      { type: "text", text: "First raw diagnostic\nSecond raw diagnostic\nThird raw diagnostic" },
      image,
    ];
    for (const expanded of [false, true, false]) {
      const component = message(
        fixture({ customType: "openai-image", details: { invalid: true }, content }),
        { expanded, outputPad: 0 },
        theme,
      )!;
      expect(images(component)).toBe(1);
      expect(component.render(160).join("\n").includes("Second raw diagnostic")).toBe(expanded);
    }
  });

  it.each([
    { status: "failed", fact: /image generation failed/i },
    { status: "in_progress", fact: /may still be running/i },
    { status: "completed", fact: /no image is attached/i },
  ])(
    "describes $status image messages without exposing provider procedures",
    ({ status, fact }) => {
      const { message } = register("compact");
      const record = {
        customType: "openai-image",
        details: { ...details, status },
        content: [{ type: "text", text: "PROVIDER_RECOVERY_COMMAND" }],
      };
      const before = structuredClone(record);
      for (const expanded of [false, true, false]) {
        const text = message(fixture(record), { expanded, outputPad: 0 }, theme)!
          .render(200)
          .join("\n");
        expect(text.includes("PROVIDER_RECOVERY_COMMAND")).toBe(expanded);
        expect(!expanded && !fact.test(text)).toBe(false);
        expect(record).toEqual(before);
      }
    },
  );

  it("retains unknown error text and cancelled result metadata", () => {
    const harness = createToolPresentationHarness(register("compact").tool, { theme });
    harness.call({ prompt: details.prompt }, { expanded: true });
    harness.result(
      {
        details: undefined,
        content: [{ type: "text", text: "Inspect saved output before retrying" }, image],
      },
      { expanded: true, isError: true },
    );
    expect(harness.render().join("\n")).toContain("Inspect saved output before retrying");
    harness.result(
      { details: { ...details, status: "cancelled" }, content: [image] },
      { expanded: true, isError: true },
    );
    expect(harness.render().join("\n")).toContain(details.revisedPrompt);
  });

  it.each(["compact", "preview"] as const)(
    "keeps exactly one custom-message Image for current and legacy %s messages",
    (style) => {
      const { message } = register(style);
      for (const legacy of [false, true]) {
        for (const expanded of [false, true, false]) {
          const component = message(
            fixture({
              customType: "openai-image",
              content: legacy ? "" : [image],
              details: legacy ? { ...details, data: image.data } : details,
            }),
            { expanded, outputPad: 0 },
            theme,
          )!;
          expect(images(component)).toBe(1);
          const text = component.render(160).join("\n");
          if (expanded || style === "preview") expect(text).toContain(details.revisedPrompt);
        }
      }
    },
  );
});
