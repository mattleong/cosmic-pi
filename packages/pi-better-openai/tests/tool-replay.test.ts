import { expect, layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { applyPresentationSettings, createToolPresentationHarness } from "pi-code-previews/testing";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { plainTheme as theme } from "pi-cosmic-core/testing";
import { afterEach, vi } from "vitest";
import { createOpenAIImageMessageRenderer, OPENAI_IMAGE_TOOL } from "../src/image/register.ts";
import { extensionHarness, ownerSource } from "./extension-harness.ts";
import { imageDetailsFixture, pngPart as image, textPart as text } from "./image-fixtures.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

const PROVIDER_TEXT = "PROVIDER_EVIDENCE recovery notes";
const details = imageDetailsFixture({
  prompt: "A watercolor otter PROMPT_END",
  revisedPrompt: "REVISED_EVIDENCE soft watercolor otter",
});
const harness = (
  toolSource = ownerSource,
  imageMessageRenderer = createOpenAIImageMessageRenderer(),
) =>
  extensionHarness({
    dependencies: { loadPreviewSettings: () => Promise.resolve(), imageMessageRenderer },
    toolSource,
  });

const presentation = Effect.acquireRelease(
  Effect.sync(() =>
    applyPresentationSettings({ toolCallCollapsedStyle: "compact", toolCallTiming: false }),
  ),
  (restore) => Effect.sync(restore),
);

layer(nodeFilePlatformLayer)("Better OpenAI history before session_start", (it) => {
  for (const owner of ["owned", "foreign"] as const)
    it.effect(`the same cold compact image row adopts only its own tool (${owner})`, () =>
      Effect.gen(function* () {
        yield* presentation;
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
        expect(Arr.join(row.render(), "\n")).toContain(PROVIDER_TEXT);

        yield* h.emit("session_start");
        expect(Arr.map(h.tools, (tool) => tool.name)).toEqual([OPENAI_IMAGE_TOOL]);
        for (const { expanded, text: rendered } of row.cycle(args, result)) {
          expect(rendered).not.toContain(image.data);
          if (expanded) {
            expect(rendered).toContain(PROVIDER_TEXT);
            if (owner === "owned") expect(rendered).toContain(details.revisedPrompt);
          } else {
            expect(Fn.pipe(rendered, Str.includes(PROVIDER_TEXT))).toBe(owner === "foreign");
          }
        }
        expect(result).toEqual(before);
        yield* h.emit("session_shutdown");
      }),
    );
});
