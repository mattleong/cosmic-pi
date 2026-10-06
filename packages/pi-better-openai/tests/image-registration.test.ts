import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Option from "effect/Option";
import type { ExtensionCommand, ExtensionSubcommand } from "pi-cosmic-core";
import { extensionApiFixture, extensionContextFixture } from "pi-cosmic-core/testing";
import { registerOpenAIImage } from "../src/image/register.ts";
import type { CodexImageResult } from "../src/image/types.ts";

const image: CodexImageResult = {
  id: "image-1",
  status: "completed",
  prompt: "draw a comet",
  data: "aW1hZ2U=",
  mimeType: "image/png",
  model: "image-model",
  action: "generate",
  outputFormat: "png",
};

function fixture() {
  let handler: ExtensionSubcommand["handler"] = () => undefined;
  let current = true;
  let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
  const sendMessage = vi.fn();
  const notify = vi.fn();
  const updateContext = vi.fn();
  const noteCwd = vi.fn();
  const command: ExtensionCommand = {
    add: (subcommand) => {
      handler = subcommand.handler;
    },
  };
  const pi = extensionApiFixture({
    registerTool(value: Parameters<ExtensionAPI["registerTool"]>[0]) {
      tool = value;
    },
    sendMessage,
  });
  const runFixture = vi.fn().mockResolvedValue(Option.some(image));
  // SAFETY: This owned runner seam returns the image-command's Option result.
  const run = runFixture as Parameters<typeof registerOpenAIImage>[2];
  registerOpenAIImage(pi, command, run, updateContext, { noteCwd, isCurrent: () => current });
  const controller = new AbortController();
  const ctx = extensionContextFixture({
    cwd: "/project",
    signal: controller.signal,
    ui: { notify },
  });
  return {
    invoke: () => handler("draw a comet", ctx),
    execute: (onUpdate: Parameters<NonNullable<typeof tool>["execute"]>[3]) =>
      tool!.execute("call", { prompt: "draw a comet" }, undefined, onUpdate, ctx),
    replace: () => {
      current = false;
    },
    abort: () => controller.abort(),
    sendMessage,
    notify,
    updateContext,
    noteCwd,
    runFixture,
  };
}

describe("image command delivery authority", () => {
  for (const retirement of ["replacement", "abort", "both"] as const) {
    it.effect(
      `rechecks ${retirement} in the queued send microtask after successful generation`,
      () =>
        Effect.gen(function* () {
          const h = fixture();
          const pending = h.invoke();
          // Queue retirement beside admission, before any Effect scheduler checkpoint.
          const retired = Promise.resolve().then(() => {
            if (retirement !== "abort") h.replace();
            if (retirement !== "replacement") h.abort();
          });
          yield* Effect.promise(() => retired);
          yield* Effect.promise(() => Promise.resolve(pending));
          expect(h.sendMessage).not.toHaveBeenCalled();
          expect(h.runFixture).toHaveBeenCalledOnce();
        }),
    );
  }

  it.effect("a retained old command closure never executes against a replacement runtime", () =>
    Effect.gen(function* () {
      const h = fixture();
      h.replace();
      yield* Effect.promise(() => Promise.resolve(h.invoke()));
      expect(h.runFixture).not.toHaveBeenCalled();
      expect(h.updateContext).not.toHaveBeenCalled();
      // The factory-scoped message renderer keeps the current session's display directory.
      expect(h.noteCwd).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
      expect(h.sendMessage).not.toHaveBeenCalled();
    }),
  );

  it.effect("a retained old tool definition rejects before context writes or progress", () =>
    Effect.gen(function* () {
      const h = fixture();
      const onUpdate = vi.fn();
      h.replace();
      yield* Effect.promise(() =>
        expect(h.execute(onUpdate)).rejects.toMatchObject({ _tag: "OpenAIBoundaryError" }),
      );
      expect(h.runFixture).not.toHaveBeenCalled();
      expect(h.updateContext).not.toHaveBeenCalled();
      expect(h.noteCwd).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
    }),
  );

  it.effect("current successful delivery preserves image content and details", () =>
    Effect.gen(function* () {
      const h = fixture();
      yield* Effect.promise(() => Promise.resolve(h.invoke()));
      expect(h.sendMessage).toHaveBeenCalledOnce();
      const { data: _data, ...details } = image;
      expect(h.sendMessage.mock.calls[0]?.[0]).toMatchObject({
        details,
        content: expect.arrayContaining([
          { type: "image", data: image.data, mimeType: image.mimeType },
        ]),
      });
    }),
  );
});
