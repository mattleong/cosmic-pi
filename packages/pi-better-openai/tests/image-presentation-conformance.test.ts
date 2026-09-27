import { Box, Container, Image, type Component } from "@earendil-works/pi-tui";
import {
  applyPresentationSettings,
  captureRegistrations,
  createToolPresentationHarness,
} from "pi-code-previews/testing";
import { opaqueFixture, plainTheme as theme } from "pi-cosmic-core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { imageRecordSummary } from "../src/image/compact-summary.ts";
import { renderImageContent } from "../src/image/presentation.ts";
import { registerOpenAIImage } from "../src/image/register.ts";
import { imageResultText } from "../src/image/result-text.ts";

const styles = ["compact", "preview"] as const;
const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
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
const text = (value: string) => ({ type: "text" as const, text: value });
function register(style: (typeof styles)[number]) {
  applyPresentationSettings({ toolCallCollapsedStyle: style, toolCallTiming: false });
  const { tools, messageRenderers } = captureRegistrations((pi) =>
    registerOpenAIImage(
      pi,
      () => {
        throw new Error("Rendering must not execute");
      },
      () => {
        throw new Error("Rendering must not update context");
      },
    ),
  );
  return { tool: tools[0]!, message: messageRenderers.get("openai-image")! };
}
const images = (component: Component): number =>
  component instanceof Image
    ? 1
    : component instanceof Container || component instanceof Box
      ? component.children.reduce((count, child) => count + images(child), 0)
      : 0;
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
/** Rendered rows without padding, blank rows, or trailing space. */
const rows = (lines: readonly string[]) =>
  lines.map((line) => line.trim()).filter((line) => line.length > 0);
afterEach(applyPresentationSettings({}));

describe("registered image presentation", () => {
  it.each(styles)("leaves image-only and text/image attachments with Pi in %s mode", (style) => {
    const { tool } = register(style);
    for (const content of [[image], [text("Original output"), image]]) {
      const result = { details, content };
      const before = structuredClone(result);
      const harness = createToolPresentationHarness(tool, { theme, width: 180 });
      for (const { expanded, text } of harness.cycle({ prompt: details.prompt }, result)) {
        if (expanded) {
          expect(text).toContain("PROMPT_END");
          expect(text).toContain(details.revisedPrompt);
          expect(text).toContain("saved image.png");
        }
        expect(text).not.toContain(image.data);
      }
      expect(result).toEqual(before);
    }
  });

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
      for (const details of [undefined, {}]) {
        const result = { details, content: [text(`${cause}\n${recovery}`)] };
        for (const expanded of [false, true]) {
          harness.call(input, { expanded });
          harness.result(result, { expanded, isError: true });
          const rendered = harness.render().join("\n");
          expect(rendered).toContain(cause);
          // The raw text appears once, under its own label, never copied into issue detail.
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
    "states each fact once when expanded, even when the raw text restates them, in %s mode",
    (style) => {
      const { tool } = register(style);
      for (const status of ["completed", "failed", "cancelled", "in_progress", "incomplete"]) {
        const record = { ...details, status };
        for (const content of [[image], [text(imageResultText(record)), image]]) {
          const result = { details: record, content };
          const before = structuredClone(result);
          const harness = createToolPresentationHarness(tool, { theme, width: 240 });
          for (const { expanded, text } of harness.cycle({ prompt: details.prompt }, result)) {
            if (!expanded) continue;
            expect(occurrences(text, "saved image.png"), text).toBe(1);
            expect(occurrences(text, details.revisedPrompt), text).toBe(1);
            expect(occurrences(text, "PROMPT_END"), text).toBe(1);
          }
          expect(result).toEqual(before);
        }
      }
    },
  );

  it.each(styles)("shows progress without the partial text while running in %s mode", (style) => {
    const harness = createToolPresentationHarness(register(style).tool, { theme, width: 160 });
    const partial = { details: undefined, content: [text("PARTIAL_PROGRESS via model…")] };
    for (const expanded of [false, true]) {
      const live = { expanded, executionStarted: true, isPartial: true };
      harness.call({ prompt: details.prompt }, live);
      harness.result(partial, live);
      expect(harness.render().join("\n")).not.toContain("PARTIAL_PROGRESS");
    }
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
          opaqueFixture({ customType: "openai-image", details: { invalid: true }, content }),
          { expanded, outputPad: 0 },
          theme,
        )!;
        expect(images(component)).toBe(1);
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
          const rendered = message(opaqueFixture(record), { expanded, outputPad: 0 }, theme)!
            .render(200)
            .join("\n");
          expect(rendered.includes("PROVIDER_RECOVERY_COMMAND")).toBe(expanded);
          for (const issue of issues) expect(rendered).toContain(issue.message);
          expect(record).toEqual(before);
        }
      }
    },
  );

  it.each(styles)(
    "renders a command message like the tool result for the same record in %s mode",
    (style) => {
      const { tool, message } = register(style);
      // Outside both working directories, so the tool and the message show the same path, and
      // short enough that the two frames' different paddings wrap nothing.
      const savedPath = "/var/images/saved image.png";
      for (const status of ["completed", "failed", "cancelled", "in_progress", "incomplete"]) {
        const record = { ...details, status, savedPath, prompt: "An otter" };
        const content = [text(imageResultText(record)), image];
        for (const expanded of [false, true]) {
          const harness = createToolPresentationHarness(tool, { theme, width: 120 });
          harness.call({ prompt: record.prompt }, { expanded });
          harness.result({ details: record, content }, { expanded });
          const toolRows = rows(harness.render(120));
          const messageRows = rows(
            message(
              opaqueFixture({ customType: "openai-image", details: record, content }),
              { expanded, outputPad: 0 },
              theme,
            )!.render(122),
          );
          // The message then draws its own image.
          expect(messageRows.slice(0, toolRows.length), `${status} ${expanded}`).toEqual(toolRows);
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

  it.each(styles)(
    "keeps exactly one custom-message Image for current and legacy %s messages",
    (style) => {
      const { message } = register(style);
      for (const legacy of [false, true]) {
        for (const expanded of [false, true, false]) {
          const component = message(
            opaqueFixture({
              customType: "openai-image",
              content: legacy ? "" : [image],
              details: legacy ? { ...details, data: image.data } : details,
            }),
            { expanded, outputPad: 0 },
            theme,
          )!;
          expect(images(component)).toBe(1);
          const rendered = component.render(160).join("\n");
          expect(rendered.includes(details.revisedPrompt)).toBe(expanded);
        }
      }
    },
  );
});
