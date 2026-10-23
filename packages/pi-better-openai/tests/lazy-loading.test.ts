import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { afterEach, vi } from "vitest";
import { OpenAIImageService } from "../src/image/service.ts";
import type { ToolParams } from "../src/image/types.ts";
import { extensionHarness } from "./extension-harness.ts";
import { testModel, waitUntil } from "./helpers.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const beforeCompactEvent = (): SessionBeforeCompactEvent => ({
  type: "session_before_compact",
  preparation: {
    firstKeptEntryId: "retained",
    messagesToSummarize: [],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 100,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
  },
  branchEntries: [],
  reason: "manual",
  willRetry: false,
  signal: new AbortController().signal,
});

layer(nodeFilePlatformLayer)("optional implementation loading", (it) => {
  it.effect("startup and ordinary hooks do not load the settings menu", () =>
    Effect.gen(function* () {
      const loadSettingsMenu = vi.fn(() => import("../src/settings/menu.ts"));
      const h = yield* extensionHarness({
        dependencies: { loadSettingsMenu },
      });
      yield* h.emit("session_start");
      yield* Effect.promise(() =>
        Promise.resolve(
          h.handlers.get("model_select")[0]!(
            { type: "model_select", model: testModel(), previousModel: undefined, source: "set" },
            h.ctx,
          ),
        ),
      );
      yield* h.emit("session_tree");
      const command = h.commands.get("openai")!;
      yield* Effect.promise(() => Promise.resolve(command.handler("settings status", h.ctx)));
      yield* Effect.promise(() =>
        Promise.resolve(command.handler("settings image.enabled true", h.ctx)),
      );
      yield* Effect.promise(() =>
        Promise.resolve(h.handlers.get("session_before_compact")[0]!(beforeCompactEvent(), h.ctx)),
      );
      yield* Effect.promise(() =>
        Promise.resolve(
          h.handlers.get("context_with_system")[0]!(
            { type: "context_with_system", messages: [] },
            h.ctx,
          ),
        ),
      );
      yield* Effect.promise(() =>
        Promise.resolve(
          h.handlers.get("before_provider_request")[0]!(
            { type: "before_provider_request", payload: {} },
            h.ctx,
          ),
        ),
      );
      expect(h.tools).toHaveLength(1);
      expect(loadSettingsMenu).not.toHaveBeenCalled();
      yield* h.emit("session_shutdown");
    }),
  );

  it.effect("shutdown interrupts image generation and replacement gets fresh execution", () =>
    Effect.gen(function* () {
      const finalized = vi.fn();
      const generate = vi.fn((params: ToolParams) =>
        params.prompt === "old"
          ? Effect.never.pipe(Effect.ensuring(Effect.sync(finalized)))
          : Effect.succeed({
              id: "image",
              status: "completed",
              prompt: params.prompt,
              model: "test-image-model",
              data: "aW1hZ2U=",
              mimeType: "image/png",
              action: "generate" as const,
              outputFormat: "png" as const,
            }),
      );
      vi.spyOn(OpenAIImageService, "make").mockReturnValue(Effect.succeed({ generate }));
      const h = yield* extensionHarness({ config: { image: { enabled: true } } });
      yield* h.emit("session_start");
      const pending = h.tools[0]!.execute(
        "old",
        { prompt: "old" },
        undefined,
        undefined,
        h.ctx,
      ).then(
        () => false,
        () => true,
      );
      yield* waitUntil(() => generate.mock.calls.length > 0);
      yield* h.emit("session_shutdown");
      expect(yield* Effect.promise(() => pending)).toBe(true);
      expect(finalized).toHaveBeenCalledOnce();
      yield* h.emit("session_start");
      const result = yield* Effect.promise(() =>
        h.tools[1]!.execute(
          "new",
          { prompt: "new", model: "test-image-model" },
          undefined,
          undefined,
          h.ctx,
        ),
      );
      expect(result.details).toMatchObject({ prompt: "new" });
      yield* h.emit("session_shutdown");
    }),
  );
});
