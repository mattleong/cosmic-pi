import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { AgentDirectory, nodePlatformLayer, SafeFile } from "pi-cosmic-core";
import {
  provideBuiltLayer,
  streamingHttpResponse,
  streamingHttpTestLayer,
  type StreamingHttpTestRequest,
} from "pi-cosmic-core/testing";
import { SharpAdapter } from "../src/boundary/sharp.ts";
import { DEFAULT_IMAGE_CONFIG, type ResolvedConfig } from "../src/config/schema.ts";
import { OpenAIImageService } from "../src/image/service.ts";
import { OpenAIImageError, type ToolParams } from "../src/image/types.ts";
import { makeResolvedConfig, testContext, testModel } from "./helpers.ts";

const registryToken = JSON.stringify({ access: "test-token", accountId: "acct_test" });
const unrelatedModel = testModel("unrelated-model", "anthropic", "anthropic-messages");
const encoder = new TextEncoder();
const responseBody = Stream.make(
  encoder.encode(
    `data: ${JSON.stringify({
      type: "image_generation_call",
      id: "generated",
      status: "completed",
      result: "YQ==",
    })}\n\n`,
  ),
);

function imageServiceLayer(options: {
  readonly context: ReturnType<typeof testContext>;
  readonly config: ResolvedConfig;
  readonly body: Parameters<typeof streamingHttpResponse>[1];
  readonly requests?: StreamingHttpTestRequest[];
  readonly decodedFormats?: readonly string[];
  readonly status?: number;
}) {
  let decodeIndex = 0;
  const http = streamingHttpTestLayer((request) => {
    options.requests?.push(request);
    return Effect.succeed(streamingHttpResponse(options.status ?? 200, options.body));
  });
  const sharp = Layer.succeed(
    SharpAdapter,
    SharpAdapter.of({
      decode: () =>
        Effect.succeed({
          format: options.decodedFormats?.[decodeIndex++] ?? "png",
        }),
    }),
  );
  return OpenAIImageService.layer({
    context: MutableRef.make(options.context),
    config: () => options.config,
  }).pipe(
    Layer.provide(Layer.merge(sharp, SafeFile.layer)),
    Layer.provide(Layer.mergeAll(nodePlatformLayer, http, AgentDirectory.layer("/agent"))),
  );
}

describe("OpenAIImageService", () => {
  it.effect("rejects unknown, blank, or unreadable parameters before any request", () => {
    const requests: StreamingHttpTestRequest[] = [];
    const hostile = new Proxy(
      { prompt: "hostile keys" },
      {
        ownKeys: () => {
          throw new Error("hostile");
        },
      },
    );
    const throwingPrompt = Object.defineProperty({ prompt: "throwing prompt" }, "prompt", {
      enumerable: true,
      get: () => {
        throw new Error("hostile");
      },
    });
    const context = testContext({ token: registryToken });
    const layer = imageServiceLayer({
      context,
      config: makeResolvedConfig(),
      body: responseBody,
      requests,
    });
    return Effect.gen(function* () {
      const service = yield* OpenAIImageService;
      const extraKey = { prompt: "extra key", detail: "high" };
      const cases: ReadonlyArray<readonly [ToolParams, string | undefined]> = [
        [extraKey, "detail"],
        [{ prompt: " \n\t " }, "prompt"],
        [{ prompt: "long directory", saveDir: "d".repeat(5_000) }, "saveDir"],
        [hostile, undefined],
        [throwingPrompt, undefined],
      ];
      for (const [params, field] of cases) {
        const failure = yield* service.generate(params).pipe(Effect.flip);
        expect(failure).toBeInstanceOf(OpenAIImageError);
        expect(failure).toMatchObject({ operation: "params" });
        if (field !== undefined) expect(failure.message).toContain(field);
      }
      expect(requests).toEqual([]);
    }).pipe(provideBuiltLayer(layer));
  });

  it.effect("treats blank optional parameters and blank image paths as absent", () => {
    const requests: StreamingHttpTestRequest[] = [];
    const layer = imageServiceLayer({
      context: testContext({ token: registryToken, model: () => unrelatedModel }),
      config: makeResolvedConfig(),
      body: responseBody,
      requests,
    });
    return Effect.gen(function* () {
      const result = yield* OpenAIImageService.use((service) =>
        service.generate({
          prompt: "blank options",
          model: "",
          saveDir: "  ",
          images: [" ", ""],
          save: "none",
        }),
      );
      expect(result).toMatchObject({
        status: "completed",
        model: DEFAULT_IMAGE_CONFIG.defaultModel,
      });
      expect(requests).toHaveLength(1);
    }).pipe(provideBuiltLayer(layer));
  });

  it.effect("reports the provider's error message from a rejected request", () =>
    Effect.gen(function* () {
      const generate = (body: string) =>
        OpenAIImageService.use((service) =>
          service.generate({ prompt: "rejected request", save: "none" }),
        ).pipe(
          provideBuiltLayer(
            imageServiceLayer({
              context: testContext({ token: registryToken }),
              config: makeResolvedConfig(),
              body: Stream.make(encoder.encode(body)),
              status: 400,
            }),
          ),
          Effect.flip,
        );

      const rejected = yield* generate(
        '{"error":{"message":"Your request was rejected by the safety system.","type":"invalid"}}',
      );
      expect(rejected).toMatchObject({ operation: "request" });
      expect(rejected.message).toContain("400");
      expect(rejected.message).toContain("rejected by the safety system");

      const unstructured = yield* generate("<html>provider-page</html>");
      expect(unstructured.message).toContain("400");
      expect(unstructured.message).not.toContain("provider-page");
    }),
  );

  it.effect("fails a rejected request with its status when the error body stalls", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const body = Stream.make(encoder.encode('{"error":{"message":"never finished')).pipe(
        Stream.concat(Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(Stream.drain)),
        Stream.concat(Stream.never),
      );
      const failure = yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "stalled rejection", save: "none" }),
      ).pipe(
        provideBuiltLayer(
          imageServiceLayer({
            context: testContext({ token: registryToken }),
            config: makeResolvedConfig(),
            body,
            status: 503,
          }),
        ),
        Effect.flip,
        Effect.forkScoped({ startImmediately: true }),
      );

      yield* Deferred.await(started);
      yield* TestClock.adjust("1 second");

      const rejected = yield* Fiber.join(failure);
      expect(rejected).toMatchObject({ operation: "request" });
      expect(rejected.message).toContain("503");
      expect(rejected.message).not.toContain("never finished");
    }),
  );

  it.effect("keeps an image returned in another format and notes the difference", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-openai-image-format-" });
      const result = yield* OpenAIImageService.use((service) =>
        service.generate({
          prompt: "format mismatch",
          outputFormat: "png",
          save: "custom",
          saveDir: directory,
        }),
      ).pipe(
        provideBuiltLayer(
          imageServiceLayer({
            context: testContext({ token: registryToken }),
            config: makeResolvedConfig(),
            body: responseBody,
            decodedFormats: ["webp"],
          }),
        ),
      );
      expect(result).toMatchObject({ outputFormat: "webp", mimeType: "image/webp" });
      expect(result.savedPath).toMatch(/\.webp$/u);
      expect(yield* fs.exists(result.savedPath ?? "")).toBe(true);
      expect(result.note).toContain("webp");
      expect(result.note).toContain("png");
    }).pipe(provideBuiltLayer(nodePlatformLayer)),
  );

  it.effect("returns a typed timeout and finalizes the interrupted response stream", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let finalized = 0;
      const body = Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(
        Stream.drain,
        Stream.concat(Stream.never),
        Stream.ensuring(
          Effect.sync(() => {
            finalized++;
          }),
        ),
      );
      const context = testContext({ token: registryToken, model: () => unrelatedModel });
      const config = makeResolvedConfig({
        image: {
          ...DEFAULT_IMAGE_CONFIG,
          defaultSave: "none",
          timeoutMs: 30_000,
        },
      });
      const failure = yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "timed request" }),
      ).pipe(
        provideBuiltLayer(imageServiceLayer({ context, config, body })),
        Effect.flip,
        Effect.forkScoped({ startImmediately: true }),
      );

      yield* Deferred.await(started);
      yield* TestClock.adjust("30 seconds");

      const timeout = yield* Fiber.join(failure);
      expect(timeout).toBeInstanceOf(OpenAIImageError);
      expect(timeout).toMatchObject({ operation: "timeout" });
      expect(finalized).toBe(1);
    }),
  );
});
