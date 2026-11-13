import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import type { CompactAnimationScheduler } from "pi-code-previews";
import {
  animationSchedulerProbe,
  applyPresentationSettings,
  createToolPresentationHarness,
  probeAnimationOwnership,
} from "pi-code-previews/testing";
import { Image } from "@earendil-works/pi-tui";
import { findOrUndefined } from "pi-cosmic-core/array";
import { stripTerminalControls } from "pi-cosmic-core/security";
import { keybindingHintsFixture, plainTheme as theme } from "pi-cosmic-core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { presentImageMessage } from "../src/image/message.ts";
import {
  imageDetailsFixture,
  pngPart as image,
  registerImagePresentation,
  textPart as text,
} from "./image-fixtures.ts";

const styles = ["compact", "preview"] as const;
const details = imageDetailsFixture({
  prompt: "Full original prompt " + Fn.pipe("long prompt ", Str.repeat(20)) + "PROMPT_END",
  revisedPrompt: "Full revised prompt",
  savedPath: "/project/saved image.png",
});
function register(style: (typeof styles)[number], scheduleAnimation?: CompactAnimationScheduler) {
  applyPresentationSettings({
    toolCallCollapsedStyle: style,
    toolCallBackground: "on",
    toolCallTiming: false,
  });
  return registerImagePresentation(scheduleAnimation);
}
afterEach(applyPresentationSettings({}));

describe("registered image presentation", () => {
  it.each(styles)("leaves image-only and text/image attachments with Pi in %s mode", (style) => {
    const { tool } = register(style);
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
        expect(findOrUndefined(result.content, (part) => part.type === "image")).toBe(image);
      }
      expect(result).toEqual(before);
    }
  });

  it("shows a whole one-line prompt once and keeps a multi-line prompt's line breaks when expanded", () => {
    const { tool } = register("compact");
    const expanded = (prompt: string) => {
      const harness = createToolPresentationHarness(tool, { theme, width: 180 });
      const shown = Arr.findFirst(
        harness.cycle({ prompt }, { details: { ...details, prompt }, content: [image] }),
        (state) => state.expanded,
      );
      return Option.getOrThrow(shown).text;
    };
    const once = expanded("A short otter prompt");
    expect(Str.split(once, "A short otter prompt").length - 1).toBe(1);
    const lines = Str.split(expanded("First line\nSecond line"), "\n");
    expect(Arr.some(lines, (line) => Str.trim(line) === "Second line")).toBe(true);
  });

  // A body may leave the prompt out only when the heading drawn in the same style showed it whole.
  it.each(
    Arr.flatMap(styles, (style) =>
      Arr.flatMap([57, 180], (width) =>
        Arr.map(["running", "completed", "failed", "cancelled", "no image"] as const, (state) => ({
          style,
          width,
          state,
        })),
      ),
    ),
  )("shows a $state $style row's whole prompt once when expanded at $width columns", (input) => {
    const prompt = "A watercolor otter reading a newspaper on a riverbank at dawn";
    const { tool } = register(input.style);
    const status = input.state === "no image" ? "completed" : input.state;
    const result =
      input.state === "running"
        ? undefined
        : {
            details: { ...details, prompt, status },
            content: input.state === "no image" ? [text("Generated image")] : [image],
          };
    const harness = createToolPresentationHarness(tool, { theme, width: input.width });
    const shown = Arr.findFirst(
      harness.cycle({ prompt }, result, { states: [false, true] }),
      (frame) => frame.expanded,
    );
    const words = Fn.pipe(
      stripTerminalControls(Option.getOrThrow(shown).text),
      Str.replace(/\s+/gu, " "),
    );
    expect(Str.split(words, prompt).length - 1).toBe(1);
  });

  it("uses the registering owner's scheduler and releases it after settlement", () => {
    const scheduler = animationSchedulerProbe();
    const { tool } = register("compact", scheduler.schedule);
    const [report] = probeAnimationOwnership([tool], scheduler, {
      args: () => ({ prompt: details.prompt }),
      result: () => ({ details, content: [image] }),
    });
    expect(report?.scheduled).toBeGreaterThan(0);
    expect(report?.invalidated).toBe(true);
    expect(report?.stops).toBeGreaterThan(0);
  });

  it.each(styles)(
    "frames a %s image message with its prompt, without mutating the message",
    (style) => {
      const { message: render } = register(style);
      const message = {
        role: "custom" as const,
        customType: "openai-image",
        content: [text("Model-facing image text"), image],
        display: true,
        details,
        timestamp: 0,
      };
      const before = structuredClone(message);
      for (const expanded of [false, true]) {
        const shown = Arr.join(
          render(message, { ...keybindingHintsFixture, expanded, outputPad: 1 }, theme)?.render(
            120,
          ) ?? [],
          "\n",
        );
        expect(shown).toContain("Full original prompt");
        if (expanded) expect(shown).toContain("PROMPT_END");
      }
      expect(message).toEqual(before);
    },
  );

  it.each(styles)(
    "offers expansion on a collapsed %s image message only when it adds facts",
    (style) => {
      const present = presentImageMessage(() => "/project");
      const shown = (
        content: Array<ReturnType<typeof text> | typeof image>,
        withDetails: boolean,
      ) =>
        present(
          {
            role: "custom",
            customType: "openai-image",
            content,
            display: true,
            details: withDetails ? details : undefined,
            timestamp: 0,
          },
          { ...keybindingHintsFixture, expanded: false, outputPad: 1, collapsedStyle: style },
          theme,
        );
      expect(shown([text("Model-facing image text")], true).expandLabel).toEqual(
        expect.any(String),
      );
      expect(shown([], false).expandLabel).toBeUndefined();
      // The message shell draws attachments below the frame; the presenter supplies the image.
      expect(shown([text("Model-facing image text"), image], true).attachments).toEqual([
        expect.any(Image),
      ]);
    },
  );
});
