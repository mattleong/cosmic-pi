import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Stream from "effect/Stream";
import { AgentDirectory, nodePlatformLayer, provideBuiltLayer, SafeFile } from "pi-cosmic-core";
import {
  makeInMemoryDocuments,
  streamingHttpResponse,
  streamingHttpTestLayer,
  type StreamingHttpTestRequest,
} from "pi-cosmic-core/testing";
import { SharpAdapter } from "../src/boundary/sharp.ts";
import { DEFAULT_IMAGE_CONFIG } from "../src/config/schema.ts";
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

describe("OpenAIImageService", () => {
  it.effect("uses one captured context/config snapshot for defaults and overrides", () => {
    const requests: StreamingHttpTestRequest[] = [];
    const decodedFormats = ["png", "webp"];
    let decodeIndex = 0;
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
    const projection = MutableRef.make({ ...initialProjection(), config });
    const documents = makeInMemoryDocuments();
    const http = streamingHttpTestLayer((request) => {
      requests.push(request);
      return Effect.succeed(streamingHttpResponse(200, responseBody));
    });
    const sharp = Layer.succeed(
      SharpAdapter,
      SharpAdapter.of({
        decode: () => Effect.succeed({ format: decodedFormats[decodeIndex++] ?? "png" }),
      }),
    );
    const serviceLayer = OpenAIImageService.layer({
      context: MutableRef.make(context),
      projection,
      agentDir: "/agent",
    }).pipe(
      Layer.provide(Layer.merge(sharp, SafeFile.layer)),
      Layer.provide(
        Layer.mergeAll(nodePlatformLayer, documents.layer, http, AgentDirectory.layer("/agent")),
      ),
    );

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
});
