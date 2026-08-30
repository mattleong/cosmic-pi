import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { AgentDirectory, nodePlatformLayer, provideBuiltLayer, SafeFile } from "pi-cosmic-core";
import {
  makeInMemoryDocuments,
  streamingHttpResponse,
  streamingHttpTestLayer,
  type StreamingHttpTestRequest,
} from "pi-cosmic-core/testing";
import { SharpAdapter } from "../src/boundary/sharp.ts";
import { DEFAULT_IMAGE_CONFIG, type ResolvedConfig } from "../src/config/schema.ts";
import { OpenAIImageService } from "../src/image/service.ts";
import { initialProjection } from "../src/usage/projection.ts";
import { makeResolvedConfig } from "./helpers.ts";

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
  readonly context: ExtensionContext;
  readonly config: ResolvedConfig;
  readonly body: Parameters<typeof streamingHttpResponse>[1];
  readonly requests?: StreamingHttpTestRequest[];
  readonly decodedFormats?: readonly string[];
}) {
  let decodeIndex = 0;
  const documents = makeInMemoryDocuments();
  const http = streamingHttpTestLayer((request) => {
    options.requests?.push(request);
    return Effect.succeed(streamingHttpResponse(200, options.body));
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
    projection: MutableRef.make({ ...initialProjection(), config: options.config }),
    agentDir: "/agent",
  }).pipe(
    Layer.provide(Layer.merge(sharp, SafeFile.layer)),
    Layer.provide(
      Layer.mergeAll(nodePlatformLayer, documents.layer, http, AgentDirectory.layer("/agent")),
    ),
  );
}

describe("OpenAIImageService", () => {
  it.effect("uses one captured context/config snapshot for defaults and overrides", () => {
    const requests: StreamingHttpTestRequest[] = [];
    let modelReads = 0;
    const contextFixture = {
      cwd: "/project",
      hasUI: true as const,
      get model() {
        modelReads++;
        return { provider: "anthropic", id: "unrelated-model" };
      },
      modelRegistry: {
        isUsingOAuth: () => true,
        getApiKeyForProvider: () =>
          Promise.resolve(JSON.stringify({ access: "test-token", accountId: "acct_test" })),
      },
      ui: { notify() {} },
    };
    // SAFETY: The image service uses only the context fields implemented by this fixture.
    const context = contextFixture as typeof contextFixture & ExtensionContext;
    const config = makeResolvedConfig({
      image: {
        ...DEFAULT_IMAGE_CONFIG,
        defaultModel: "default-image-model",
        defaultSave: "none",
        timeoutMs: 10_000,
      },
    });
    const serviceLayer = imageServiceLayer({
      context,
      config,
      body: responseBody,
      requests,
      decodedFormats: ["png", "webp"],
    });

    return Effect.gen(function* () {
      const service = yield* OpenAIImageService;
      const defaulted = yield* service.generate({ prompt: "default request" });
      const overridden = yield* service.generate({
        prompt: "override request",
        model: "openai-codex/override-model",
        action: "edit",
        outputFormat: "webp",
        save: "none",
      });

      expect(defaulted).toMatchObject({
        model: "default-image-model",
        action: "auto",
        outputFormat: "png",
        mimeType: "image/png",
      });
      expect(overridden).toMatchObject({
        model: "override-model",
        action: "edit",
        outputFormat: "webp",
        mimeType: "image/webp",
      });
      expect(requests[0]?.encodedJsonBody).toMatchObject({
        model: "default-image-model",
        tools: [{ output_format: "png" }],
      });
      expect(requests[1]?.encodedJsonBody).toMatchObject({
        model: "override-model",
        tools: [{ output_format: "webp", action: "edit" }],
      });
      expect(modelReads).toBe(1);
    }).pipe(provideBuiltLayer(serviceLayer));
  });

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
      const contextFixture = {
        cwd: "/project",
        hasUI: true as const,
        model: { provider: "anthropic", id: "unrelated-model" },
        modelRegistry: {
          isUsingOAuth: () => true,
          getApiKeyForProvider: () =>
            Promise.resolve(JSON.stringify({ access: "test-token", accountId: "acct_test" })),
        },
        ui: { notify() {} },
      };
      // SAFETY: The image service uses only the context fields implemented by this fixture.
      const context = contextFixture as typeof contextFixture & ExtensionContext;
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

      expect(yield* Fiber.join(failure)).toMatchObject({
        _tag: "OpenAIImageError",
        operation: "timeout",
        message: "OpenAI image request timed out.",
      });
      expect(finalized).toBe(1);
    }),
  );
});
