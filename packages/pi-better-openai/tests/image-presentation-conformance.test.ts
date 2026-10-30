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
import { plainTheme as theme } from "pi-cosmic-core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { pngPart as image, registerImagePresentation, textPart as text } from "./image-fixtures.ts";

const styles = ["compact", "preview"] as const;
const backgrounds = ["on"] as const;
const details = {
  id: "image-identity",
  status: "completed",
  prompt: "Full original prompt " + Fn.pipe("long prompt ", Str.repeat(20)) + "PROMPT_END",
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
afterEach(applyPresentationSettings({}));

/** Image rows without the terminal image id each native image draws under. */
const anonymous = (rows: ReadonlyArray<string>) =>
  Arr.map(rows, (row) => Str.replace(/\bi=\d+/gu, "i=*")(row));

describe("registered image presentation", () => {
  it.each(
    Arr.flatMap(styles, (style) => Arr.map(backgrounds, (background) => ({ style, background }))),
  )(
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
          expect(
            Option.getOrUndefined(Arr.findFirst(result.content, (part) => part.type === "image")),
          ).toBe(image);
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

  it.each(
    Arr.flatMap(styles, (style) =>
      Arr.map(["border", "on", "off"] as const, (background) => ({ style, background })),
    ),
  )(
    "frames image messages like tool rows and keeps Pi's native image in $style/$background mode",
    ({ style, background }) => {
      const { message: render } = register(style, "on");
      applyPresentationSettings({ toolCallCollapsedStyle: style, toolCallBackground: background });
      const message = {
        role: "custom" as const,
        customType: "openai-image",
        content: [text("Model-facing image text"), image],
        display: true,
        details,
        timestamp: 0,
      };
      const before = structuredClone(message);
      const native = anonymous(
        new Image(
          image.data,
          image.mimeType,
          { fallbackColor: (line) => theme.fg("dim", line) },
          { maxWidthCells: 80, maxHeightCells: 24, filename: details.savedPath },
        ).render(120),
      );
      for (const expanded of [false, true]) {
        const rows = anonymous(
          render(message, { expanded, outputPad: 1 }, theme)?.render(120) ?? [],
        );
        const at = Option.getOrThrow(Arr.findFirstIndex(rows, (row) => row === native[0]));
        // The image follows the frame unchanged, as Pi draws a tool result's images.
        expect(rows.slice(at, at + native.length)).toEqual(native);
        const shown = Arr.join(rows.slice(0, at), "\n");
        expect(shown).toContain("Full original prompt");
        if (expanded) expect(shown).toContain("PROMPT_END");
      }
      expect(message).toEqual(before);
    },
  );
});
