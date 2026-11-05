import {
  galleryDirectory,
  galleryFrames,
  galleryMessageFrames,
  galleryTranscriptFrames,
  withPresentationSettings,
  writeGallerySection,
  type GalleryMessageScenario,
  type GalleryScenario,
} from "pi-code-previews/testing";
import { beforeAll, describe, it } from "@effect/vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { stripTerminalControls } from "pi-cosmic-core";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { fastStateText, inactiveForModelMessage } from "../src/fast/controller.ts";
import { imageResultText } from "../src/image/result-text.ts";
import { HIDDEN_USAGE_STATUS_TEXT } from "../src/usage/projection.ts";
import { makeResolvedConfig, testModel } from "./helpers.ts";
import { input, settingsHarnessWith, type SettingsHarnessOptions } from "./settings-harness.ts";
import { formatUsageDetails, formatUsageStatus, type UsageSnapshot } from "../src/usage/format.ts";
import type { CodexImageDetails } from "../src/image/types.ts";
import { registerImagePresentation, textPart } from "./image-fixtures.ts";

const settingsHarness = (options?: SettingsHarnessOptions) =>
  settingsHarnessWith(makeResolvedConfig({ configPath: "/tmp/openai-settings.json" }), options);

const text = (value: string) => [textPart(value)];
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
  model: "gpt-6.1-sol",
  imageModel: "gpt-image-2.5-sunburst",
  action: "generate",
  outputFormat: "png",
});
const { savedPath: _savedPath, ...unsaved } = details("completed");
/** A later image the user asked for with `/openai image`; no tool row describes it. */
const commandDetails: CodexImageDetails = {
  ...details("completed", "A paper boat drifting across a rain puddle"),
  id: "ig_9f8e7d6c",
  revisedPrompt: "A folded paper boat floating on a rippled rain puddle under grey skies",
  savedPath: "/project/.pi/generated-images/openai-image-2026-09-27T10-04-12-000Z-ig_9f8e7d6c.png",
};
const imageResult = (status: string, request = prompt) => ({
  content: [...text(imageResultText(details(status, request))), image],
  details: details(status, request),
});
const failure = (message: string) => ({ content: text(message), details: {} });

const toolScenarios: ReadonlyArray<GalleryScenario> = [
  {
    title: "requesting an image",
    args,
    phase: "running",
    result: {
      content: text("Requesting OpenAI image_generation via gpt-6.1-sol…"),
      details: undefined,
    },
  },
  { title: "completed with an image", args, result: imageResult("completed") },
  {
    title: "completed without saving a file",
    args: { ...args, save: "none" },
    result: { content: [...text(imageResultText(unsaved)), image], details: unsaved },
  },
  {
    title: "completed with a short prompt",
    args: { prompt: "An otter", action: "generate" },
    result: imageResult("completed", "An otter"),
  },
  {
    title: "completed without an image",
    args,
    result: { content: text(imageResultText(details("completed"))), details: details("completed") },
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
    title: "OpenAI rejected the request",
    args,
    isError: true,
    result: failure(
      "Image generation failed: Your request was rejected by the safety system (HTTP 400).",
    ),
  },
  {
    title: "OpenAI failed without a reason",
    args,
    isError: true,
    result: failure("Image generation failed: OpenAI gave no reason."),
  },
  {
    title: "disabled in config",
    args,
    isError: true,
    result: failure("Image generation is off: turn it on in /openai settings."),
  },
  {
    title: "invalid parameters",
    args: { prompt, action: "edit", images: ["/project/photos/otter.jpg"], outputFormat: "webp" },
    isError: true,
    result: failure("Invalid OpenAI image parameters."),
  },
];

const message = (
  status: string,
  shown: CodexImageDetails = details(status),
): GalleryMessageScenario["message"] => ({
  role: "custom",
  customType: "openai-image",
  content: [...text(imageResultText(shown)), image],
  display: true,
  details: shown,
  timestamp: 0,
});
const messageScenarios: ReadonlyArray<GalleryMessageScenario> = [
  { title: "image message completed", message: message("completed") },
  { title: "image message failed", message: message("failed") },
  { title: "image message cancelled", message: message("cancelled") },
];

const now = Date.UTC(2026, 10, 3, 22, 30);
const usage = (fiveHourLeftPercent: number | null): UsageSnapshot => ({
  capturedAt: now,
  fiveHourLeftPercent,
  sevenDayLeftPercent: 90,
  fiveHourResetInSeconds: fiveHourLeftPercent === null ? null : 2 * 3_600 + 180,
  sevenDayResetInSeconds: 6 * 86_400 + 3_600,
});
const textFrame = (title: string, shown: string | undefined): string[] => [
  `── ${title}`,
  ...(shown === undefined ? ["(nothing shown)"] : Str.split(shown, "\n")),
  "",
];
const usageFrames = (): string[] => [
  ...textFrame("/openai usage · both windows reported", formatUsageDetails(usage(42), now)),
  ...textFrame("/openai usage · 5-hour window not reported", formatUsageDetails(usage(null), now)),
  ...textFrame(
    "usage status without the Cosmic UI footer",
    formatUsageStatus(usage(42), { showResetTimes: true }, now),
  ),
  ...textFrame(
    "usage status without the Cosmic UI footer · 5-hour window not reported",
    formatUsageStatus(usage(null), { showResetTimes: false }, now),
  ),
];

/** Notices Pi draws one column in; wrapped here at a phone's and a desktop's notice width. */
const noticeFrames = (title: string, notice: string): string[] =>
  Arr.flatMap([55, 178], (width) => [
    `── notice · ${title} · ${width + 2} cols`,
    ...Arr.flatMap(Str.split(notice, "\n"), (line) => wrapTextWithAnsi(line, width)),
    "",
  ]);
const claude = extensionContextFixture({
  model: testModel("claude-opus-5-5", "anthropic", "anthropic-messages"),
});
const noticeLines = (): string[] => [
  ...noticeFrames(
    "/openai fast on a model without fast mode",
    fastStateText(claude, { desiredActive: true, active: false }),
  ),
  ...noticeFrames("switched to a model without fast mode", inactiveForModelMessage(claude)),
  ...noticeFrames("/openai usage on a model without usage", HIDDEN_USAGE_STATUS_TEXT),
];

/** `/openai settings` and its groups, at a desktop and a phone width. */
const settingsLines = Effect.gen(function* () {
  const h = settingsHarness();
  yield* h.open;
  const component = h.selectedComponent();
  const frames = (title: string) =>
    Arr.flatMap([100, 57], (width) => [
      `── settings · ${title} · ${width} cols`,
      ...Arr.map(component.render(width), (line) => Str.trimEnd(stripTerminalControls(line))),
      "",
    ]);
  const group = (title: string, downs: number) => {
    for (let step = 0; step < downs; step++) component.handleInput?.(input.down);
    component.handleInput?.(input.enter);
    const shown = frames(title);
    component.handleInput?.(input.escape);
    for (let step = 0; step < downs; step++) component.handleInput?.(input.up);
    return shown;
  };
  return [
    ...frames("top level"),
    ...group("Fast mode group", 0),
    ...group("Usage group", 2),
    ...group("Image tool group", 3),
  ];
});

const directory = galleryDirectory(process.env) ?? "";

describe.skipIf(!directory)("presentation gallery", () => {
  beforeAll(() => initTheme("dark", false));

  it.effect("renders image tool calls and messages in both collapsed styles", () =>
    Effect.gen(function* () {
      const lines: string[] = [];
      for (const style of ["compact", "preview"] as const)
        withPresentationSettings({ toolCallCollapsedStyle: style, toolCallTiming: false }, () => {
          const { tool, message: renderMessage } = registerImagePresentation(undefined, "/project");
          for (const scenario of toolScenarios)
            lines.push(
              ...galleryFrames(tool, { ...scenario, title: `${style} · ${scenario.title}` }),
            );
          for (const scenario of messageScenarios)
            lines.push(
              ...galleryMessageFrames(renderMessage, {
                ...scenario,
                title: `${style} · ${scenario.title}`,
              }),
            );
          for (const background of ["border", "on", "off"] as const)
            withPresentationSettings({ toolCallBackground: background }, () => {
              const framed = registerImagePresentation(undefined, "/project");
              const completed = Option.getOrThrow(
                Arr.findFirst(toolScenarios, (entry) => entry.title === "completed with an image"),
              );
              lines.push(
                ...galleryTranscriptFrames(
                  `${style} · ${background} · transcript: the agent's openai_image call, then the user's /openai image message`,
                  [
                    {
                      name: framed.tool.name,
                      tool: framed.tool,
                      args: completed.args,
                      result: completed.result!,
                    },
                    { render: framed.message, message: message("completed", commandDetails) },
                  ],
                ),
              );
            });
        });
      lines.push(...usageFrames(), ...noticeLines(), ...(yield* settingsLines));
      yield* writeGallerySection(directory, "pi-better-openai", lines);
    }),
  );
});
