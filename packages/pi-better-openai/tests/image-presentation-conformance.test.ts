import type { CompactAnimationScheduler } from "pi-code-previews";
import {
  animationSchedulerProbe,
  applyPresentationSettings,
  createToolPresentationHarness,
  probeAnimationOwnership,
} from "pi-code-previews/testing";
import { plainTheme as theme } from "pi-cosmic-core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { imageRecordSummary } from "../src/image/compact-summary.ts";
import { renderImageContent } from "../src/image/presentation.ts";
import {
  countImages,
  imageMessage,
  pngPart as image,
  registerImagePresentation,
  textPart as text,
} from "./image-fixtures.ts";

const styles = ["compact", "preview"] as const;
const backgrounds = ["on", "off", "border"] as const;
const details = {
  id: "image-identity",
  status: "completed",
  prompt: "Full original prompt " + "long prompt ".repeat(20) + "PROMPT_END",
  revisedPrompt: "Full revised prompt",
  savedPath: "/project/saved image.png",
  mimeType: image.mimeType,
  model: "model",
  action: "generate" as const,
  outputFormat: "png" as const,
};
function register(
  style: (typeof styles)[number],
  background: (typeof backgrounds)[number] = "on",
  scheduleAnimation?: CompactAnimationScheduler,
) {
  applyPresentationSettings({
    toolCallCollapsedStyle: style,
    toolCallBackground: background,
    toolCallTiming: false,
  });
  return registerImagePresentation(scheduleAnimation);
}
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
afterEach(applyPresentationSettings({}));

describe("registered image presentation", () => {
  it.each(styles.flatMap((style) => backgrounds.map((background) => ({ style, background }))))(
    "leaves image-only and text/image attachments with Pi in $style/$background mode",
    ({ style, background }) => {
      const { tool } = register(style, background);
      for (const content of [[image], [text("Original output"), image]]) {
        const result = { details, content };
        const before = structuredClone(result);
        const harness = createToolPresentationHarness(tool, { theme, width: 180 });
        for (const { expanded, text: rendered } of harness.cycle(
          { prompt: details.prompt },
          result,
        )) {
          if (expanded) {
            expect(rendered).toContain("PROMPT_END");
            expect(rendered).toContain(details.revisedPrompt);
            expect(rendered).toContain("saved image.png");
          }
          expect(rendered).not.toContain(image.data);
          expect(result.content.find((part) => part.type === "image")).toBe(image);
        }
        expect(result).toEqual(before);
      }
    },
  );

  it.each(backgrounds)(
    "uses the registering owner's scheduler and releases it after settlement in %s mode",
    (background) => {
      const scheduler = animationSchedulerProbe();
      const { tool } = register("compact", background, scheduler.schedule);
      const [report] = probeAnimationOwnership([tool], scheduler, {
        args: () => ({ prompt: details.prompt }),
        result: () => ({ details, content: [image] }),
      });
      expect(report?.scheduled).toBeGreaterThan(0);
      expect(report?.invalidated).toBe(true);
      expect(report?.stops).toBeGreaterThan(0);
    },
  );

  it.each(styles)(
    "shows a failure's first line collapsed and its raw text with the whole request expanded in %s mode",
    (style) => {
      const harness = createToolPresentationHarness(register(style).tool, { theme, width: 240 });
      const cause = "Image request failed";
      const recovery = "Inspect local output before retrying";
      const input = {
        action: "edit",
        prompt: "Full original request " + "context ".repeat(30) + "PROMPT_EVIDENCE",
        images: ["/project/original-input.png"],
        save: "custom",
        saveDir: "/project/image-target",
        outputFormat: "webp",
      };
      for (const resultDetails of [undefined, {}]) {
        const result = { details: resultDetails, content: [text(`${cause}\n${recovery}`)] };
        for (const expanded of [false, true]) {
          harness.call(input, { expanded });
          harness.result(result, { expanded, isError: true });
          const rendered = harness.render().join("\n");
          expect(rendered).toContain(cause);
          expect(occurrences(rendered, recovery)).toBe(expanded ? 1 : 0);
          if (!expanded) continue;
          expect(rendered).toContain("PROMPT_EVIDENCE");
          expect(rendered).toContain("/project/original-input.png");
          expect(rendered).toContain("/project/image-target");
          expect(rendered).toContain("webp");
        }
      }
    },
  );

  it.each(styles)(
    "keeps request and output text after terminal string controls once expanded in %s mode",
    (style) => {
      const harness = createToolPresentationHarness(register(style).tool, { theme, width: 240 });
      const input = {
        prompt: "Paint a fox\u009d AFTER_PROMPT_CONTROL",
        save: "custom",
        saveDir: "/project/out\u001b] AFTER_OPTION_CONTROL",
      };
      const record = { ...details, revisedPrompt: "Revised\u009d AFTER_REVISED_CONTROL" };
      const cases = [
        { result: { details: record, content: [image] }, output: "AFTER_REVISED_CONTROL" },
        {
          result: { details: undefined, content: [text("Failed\u009d AFTER_RAW_CONTROL")] },
          output: "AFTER_RAW_CONTROL",
        },
      ];
      for (const { result, output } of cases) {
        harness.call(input, { expanded: true });
        harness.result(result, { expanded: true, isError: result.details === undefined });
        const rendered = harness.render().join("\n");
        for (const marker of ["AFTER_PROMPT_CONTROL", "AFTER_OPTION_CONTROL", output])
          expect(rendered).toContain(marker);
        expect(rendered).not.toContain("\u009d");
        expect(rendered).not.toContain("\u001b]");
      }
    },
  );

  it.each(styles)("shows progress without the partial text while running in %s mode", (style) => {
    const harness = createToolPresentationHarness(register(style).tool, { theme, width: 160 });
    const partial = { details: undefined, content: [text("PARTIAL_PROGRESS via model…")] };
    const frames = harness.cycle({ prompt: details.prompt }, partial, {
      states: [false, true],
      overrides: () => ({ executionStarted: true, isPartial: true }),
    });
    for (const { text: rendered } of frames) expect(rendered).not.toContain("PARTIAL_PROGRESS");
  });

  it("does not let raw prose claim structured image metadata", () => {
    const raw = `Untrusted description mentions Saved: ${details.savedPath}, but is not that field.`;
    const rendered = renderImageContent(
      { details, content: [text(raw)] },
      { expanded: true, isPartial: false },
      theme,
      { cwd: "/elsewhere", isError: false },
    )
      .render(240)
      .join("\n");
    expect(rendered).toContain(raw);
    expect(occurrences(rendered, details.savedPath)).toBe(2);
  });

  it.each(styles)(
    "keeps malformed %s messages brief and restores raw details on expansion",
    (style) => {
      const { message } = register(style);
      const content = [
        text("First raw diagnostic\nSecond raw diagnostic\nThird raw diagnostic"),
        image,
      ];
      for (const expanded of [false, true, false]) {
        const component = message(
          imageMessage(content, { invalid: true }),
          { expanded, outputPad: 0 },
          theme,
        )!;
        expect(countImages(component)).toBe(1);
        expect(component.render(160).join("\n").includes("Second raw diagnostic")).toBe(expanded);
      }
    },
  );

  it.each(styles)(
    "describes %s image messages with the tool's classification, hiding provider text until expanded",
    (style) => {
      const { message } = register(style);
      for (const status of ["failed", "in_progress", "incomplete", "completed"]) {
        const record = {
          customType: "openai-image",
          details: { ...details, status },
          content: [text("PROVIDER_RECOVERY_COMMAND")],
        };
        const issues =
          imageRecordSummary(record.details, { hasImage: false, expanded: false })?.issues ?? [];
        expect(issues.length).toBeGreaterThan(0);
        const before = structuredClone(record);
        for (const expanded of [false, true, false]) {
          const rendered = message(
            imageMessage(record.content, record.details),
            { expanded, outputPad: 0 },
            theme,
          )!
            .render(200)
            .join("\n");
          expect(rendered.includes("PROVIDER_RECOVERY_COMMAND")).toBe(expanded);
          for (const issue of issues) expect(rendered).toContain(issue.message);
          expect(record).toEqual(before);
        }
      }
    },
  );

  it("retains unknown error text and cancelled result metadata", () => {
    const harness = createToolPresentationHarness(register("compact").tool, { theme });
    harness.call({ prompt: details.prompt }, { expanded: true });
    harness.result(
      { details: undefined, content: [text("Inspect saved output before retrying"), image] },
      { expanded: true, isError: true },
    );
    expect(harness.render().join("\n")).toContain("Inspect saved output before retrying");
    harness.result(
      { details: { ...details, status: "cancelled" }, content: [image] },
      { expanded: true, isError: true },
    );
    expect(harness.render().join("\n")).toContain(details.revisedPrompt);
  });

  it.each(styles)("keeps exactly one custom-message Image for %s messages", (style) => {
    const { message } = register(style);
    for (const status of ["completed", "cancelled"]) {
      const record = { ...details, status };
      for (const expanded of [false, true, false]) {
        const component = message(
          imageMessage([image], record),
          { expanded, outputPad: 0 },
          theme,
        )!;
        expect(countImages(component)).toBe(1);
        const rendered = component.render(160).join("\n");
        expect(rendered.includes(details.revisedPrompt)).toBe(expanded);
        if (expanded) {
          expect(rendered).toContain("PROMPT_END");
          expect(rendered).toContain(details.savedPath);
        }
      }
    }
  });
});
