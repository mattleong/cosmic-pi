import {
  applyPresentationSettings,
  captureRegistrations,
  galleryDirectory,
  galleryFrames,
  galleryMessageFrames,
  writeGallerySection,
  type GalleryMessageScenario,
  type GalleryScenario,
} from "pi-code-previews/testing";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { registerOpenAIImage } from "../src/image/register.ts";
import type { CodexImageDetails } from "../src/image/types.ts";

const noExecution = () => {
  throw new Error("Rendering must not execute");
};
const noContext = () => {
  throw new Error("Rendering must not update context");
};
const text = (value: string) => [{ type: "text" as const, text: value }];
const image = {
  type: "image" as const,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  mimeType: "image/png",
};

const prompt = "A watercolor otter reading a newspaper on a riverbank at dawn";
const args = { prompt, action: "generate" };
const details = (status: string, request = prompt): CodexImageDetails => ({
  id: "ig_0a1b2c3d",
  status,
  prompt: request,
  revisedPrompt: "A soft watercolor painting of an otter reading a folded newspaper at dawn",
  mimeType: image.mimeType,
  savedPath: "/project/.pi/generated-images/openai-image-2026-09-27T10-00-00-000Z-ig_0a1b2c3d.png",
  model: "gpt-5.5",
  imageModel: "gpt-image-2.5-sunburst",
  action: "generate",
  outputFormat: "png",
});
// The same agent-facing text the tool and command attach beside the image.
const resultText = (record: CodexImageDetails) =>
  [
    `Generated image using OpenAI image_generation tool via openai-codex/${record.model}.`,
    `Action: ${record.action}.`,
    `Prompt: ${record.prompt}`,
    ...(record.imageModel ? [`Image model: ${record.imageModel}.`] : []),
    ...(record.revisedPrompt ? [`Revised prompt: ${record.revisedPrompt}`] : []),
    ...(record.savedPath ? [`Saved: ${record.savedPath}`] : []),
  ].join("\n");
const imageResult = (status: string, request = prompt) => ({
  content: [...text(resultText(details(status, request))), image],
  details: details(status, request),
});
// Pi turns a rejected tool execution into text content with empty details.
const failure = (message: string) => ({ content: text(message), details: {} });

const toolScenarios: ReadonlyArray<GalleryScenario> = [
  {
    title: "requesting an image",
    args,
    phase: "running",
    result: {
      content: text("Requesting OpenAI image_generation via gpt-5.5…"),
      details: undefined,
    },
  },
  { title: "completed with an image", args, result: imageResult("completed") },
  {
    title: "completed with a short prompt",
    args: { prompt: "An otter", action: "generate" },
    result: imageResult("completed", "An otter"),
  },
  {
    title: "completed without an image",
    args,
    result: { content: text(resultText(details("completed"))), details: details("completed") },
  },
  { title: "failed", args, result: imageResult("failed") },
  { title: "cancelled", args, result: imageResult("cancelled") },
  { title: "still in progress", args, result: imageResult("in_progress") },
  { title: "incomplete", args, result: imageResult("incomplete") },
  {
    title: "sign-in required",
    args,
    isError: true,
    result: failure("Missing openai-codex OAuth credentials. Run /login openai-codex."),
  },
  {
    title: "disabled in config",
    args,
    isError: true,
    result: failure("OpenAI image generation is disabled in config."),
  },
  {
    title: "invalid parameters",
    args: { prompt, action: "edit", images: ["/project/photos/otter.jpg"], outputFormat: "webp" },
    isError: true,
    result: failure("Invalid OpenAI image parameters."),
  },
];

const message = (status: string): GalleryMessageScenario["message"] => ({
  role: "custom",
  customType: "openai-image",
  content: [...text(resultText(details(status))), image],
  display: true,
  details: details(status),
  timestamp: 0,
});
const messageScenarios: ReadonlyArray<GalleryMessageScenario> = [
  { title: "image message completed", message: message("completed") },
  { title: "image message failed", message: message("failed") },
  { title: "image message cancelled", message: message("cancelled") },
];

const directory = galleryDirectory(process.env) ?? "";

describe.skipIf(!directory)("presentation gallery", () => {
  it.effect("renders image tool calls and messages in both collapsed styles", () =>
    Effect.gen(function* () {
      const lines: string[] = [];
      for (const style of ["compact", "preview"] as const) {
        const restore = applyPresentationSettings({
          toolCallCollapsedStyle: style,
          toolCallTiming: false,
        });
        try {
          const { tools, messageRenderers } = captureRegistrations((pi) =>
            registerOpenAIImage(pi, noExecution, noContext),
          );
          const tool = tools.find((entry) => entry.name === "openai_image")!;
          const renderer = messageRenderers.get("openai-image")!;
          for (const scenario of toolScenarios)
            lines.push(
              ...galleryFrames(tool, { ...scenario, title: `${style} · ${scenario.title}` }),
            );
          for (const scenario of messageScenarios)
            lines.push(
              ...galleryMessageFrames(renderer, {
                ...scenario,
                title: `${style} · ${scenario.title}`,
              }),
            );
        } finally {
          restore();
        }
      }
      yield* writeGallerySection(directory, "pi-better-openai", lines);
    }),
  );
});
