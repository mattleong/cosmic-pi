import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { applyPresentationSettings, createToolPresentationHarness } from "pi-code-previews/testing";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { plainTheme as theme } from "pi-cosmic-core/testing";
import { afterEach, vi } from "vitest";
import { createOpenAIImageMessageRenderer, OPENAI_IMAGE_TOOL } from "../src/image/register.ts";
import { extensionHarness, ownerSource } from "./extension-harness.ts";
import {
  countImages,
  imageMessage,
  pngPart as image,
  textPart as text,
  type ImageCustomMessage,
} from "./image-fixtures.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

const styles = ["compact", "preview"] as const;
const PROVIDER_TEXT = "PROVIDER_EVIDENCE recovery notes";
const details = {
  id: "image-identity",
  status: "completed",
  prompt: "A watercolor otter PROMPT_END",
  revisedPrompt: "REVISED_EVIDENCE soft watercolor otter",
  mimeType: image.mimeType,
  model: "model",
  action: "generate" as const,
  outputFormat: "png" as const,
};
const harness = (
  toolSource = ownerSource,
  imageMessageRenderer = createOpenAIImageMessageRenderer(),
) =>
  extensionHarness({
    dependencies: { loadPreviewSettings: () => Promise.resolve(), imageMessageRenderer },
    toolSource,
  });

const presentation = (style: (typeof styles)[number]) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      applyPresentationSettings({ toolCallCollapsedStyle: style, toolCallTiming: false }),
    ),
    (restore) => Effect.sync(restore),
  );

layer(nodeFilePlatformLayer)("Better OpenAI history before session_start", (it) => {
  for (const style of styles)
    for (const owner of ["owned", "foreign"] as const)
      it.effect(`the same cold ${style} image row adopts only its own tool (${owner})`, () =>
        Effect.gen(function* () {
          yield* presentation(style);
          const h = yield* harness(
            owner === "owned" ? ownerSource : { ...ownerSource, path: "/extensions/foreign.ts" },
          );
          const cold = h.resolve(OPENAI_IMAGE_TOOL);
          expect(cold).toBeDefined();
          const row = createToolPresentationHarness(cold!, { theme, width: 240 });
          const args = { prompt: details.prompt };
          const result = { details, content: [text(PROVIDER_TEXT), image] };
          const before = structuredClone(result);
          row.call(args);
          row.result(result);
          expect(row.render().join("\n")).toContain(PROVIDER_TEXT);

          yield* h.emit("session_start");
          expect(h.tools.map((tool) => tool.name)).toEqual([OPENAI_IMAGE_TOOL]);
          for (const { expanded, text } of row.cycle(args, result)) {
            expect(text).not.toContain(image.data);
            if (expanded) {
              expect(text).toContain(PROVIDER_TEXT);
              if (owner === "owned") expect(text).toContain(details.revisedPrompt);
            } else {
              expect(text.includes(PROVIDER_TEXT)).toBe(owner === "foreign");
            }
          }
          expect(result).toEqual(before);
          yield* h.emit("session_shutdown");
        }),
      );

  for (const style of styles)
    it.effect(`image messages render before session_start with their native image (${style})`, () =>
      Effect.gen(function* () {
        yield* presentation(style);
        const messageRenderer = createOpenAIImageMessageRenderer();
        const h = yield* harness(ownerSource, messageRenderer);
        expect(h.messageRenderers.get("openai-image")).toBe(messageRenderer.render);
        const savedPath = `${h.cwd}/.pi/generated-images/otter.png`;
        const record = { ...details, savedPath };
        const render = <Details>(message: {
          readonly content: ImageCustomMessage["content"];
          readonly details: Details;
        }) =>
          messageRenderer.render(
            imageMessage(message.content, message.details),
            { expanded: true, outputPad: 0 },
            theme,
          )!;
        const expectImages = () => {
          const component = render({ content: [text(PROVIDER_TEXT), image], details: record });
          expect(countImages(component)).toBe(1);
          expect(component.render(400).join("\n")).toContain(details.revisedPrompt);
        };
        const savedPathShown = () =>
          render({ content: [text(PROVIDER_TEXT)], details: record })
            .render(400)
            .join("\n");

        expectImages();
        const beforeStartup = savedPathShown();
        expect(beforeStartup).toContain(".pi/generated-images/otter.png");
        yield* h.emit("session_start");
        expectImages();
        expect(savedPathShown()).toContain(".pi/generated-images/otter.png");
        expect(savedPathShown()).not.toEqual(beforeStartup);
        expect(savedPathShown()).not.toContain(h.cwd);
        yield* h.emit("session_shutdown");
      }),
    );
});
