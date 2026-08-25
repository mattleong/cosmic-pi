import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { nodePlatformLayer, provideBuiltLayer, SafeFile } from "pi-cosmic-core";
import type { SharpAdapterContract } from "../src/boundary/sharp.ts";
import { makeImageInputReader } from "../src/image/input.ts";
import { makeImageOutput } from "../src/image/output.ts";
import { parseImageSse } from "../src/image/stream.ts";

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);
const body = (value: string) => Stream.make(bytes(value));
const dataEvent = <Value>(value: Value) => `data: ${JSON.stringify(value)}\n\n`;

const pngSharp: SharpAdapterContract = {
  decode: () => Effect.succeed({ format: "png" }),
};

const fileLayer = Layer.merge(
  nodePlatformLayer,
  SafeFile.layer.pipe(Layer.provide(nodePlatformLayer)),
);

describe("OpenAI image protocol", () => {
  it.effect("ignores unknown events and accepts wrapped completion", () =>
    Effect.gen(function* () {
      const result = yield* parseImageSse(
        body(
          dataEvent({ type: "response.in_progress", sequence_number: 1 }) +
            dataEvent({
              type: "response.output_item.done",
              item: {
                type: "image_generation_call",
                id: "wrapped",
                status: "completed",
                result: "data:image/webp;base64,YQ==",
              },
            }),
        ),
        "image/png",
      );

      expect(result).toMatchObject({
        id: "wrapped",
        status: "completed",
        data: "YQ==",
        mimeType: "image/png",
      });
    }),
  );

  it.effect("accepts a direct completion from an unterminated final event", () =>
    Effect.gen(function* () {
      const result = yield* parseImageSse(
        body('data: {"type":"image_generation_call","id":"direct","b64_json":"Yg=="}'),
        "image/png",
      );

      expect(result).toMatchObject({ id: "direct", status: "completed", data: "Yg==" });
    }),
  );

  it.effect("keeps partial images nonterminal", () =>
    Effect.gen(function* () {
      const result = yield* parseImageSse(
        body(
          dataEvent({ partial_image_b64: "cGFydGlhbA==" }) +
            dataEvent({
              type: "image_generation_call",
              id: "complete",
              status: "completed",
              result: "ZmluYWw=",
            }),
        ),
        "image/png",
      );

      expect(result).toMatchObject({ id: "complete", data: "ZmluYWw=" });
    }),
  );

  it.effect("fails malformed known events and a terminal without completion", () =>
    Effect.gen(function* () {
      const malformed = yield* parseImageSse(
        body(
          dataEvent({
            type: "response.output_item.done",
            item: { type: "image_generation_call", result: 42 },
          }),
        ),
        "image/png",
      ).pipe(Effect.result);
      const terminated = yield* parseImageSse(body("data: [DONE]\n\n"), "image/png").pipe(
        Effect.result,
      );

      expect(malformed._tag).toBe("Failure");
      if (malformed._tag === "Failure") {
        expect(malformed.failure.operation).toBe("stream");
        expect(malformed.failure.message).toContain("malformed event");
      }
      expect(terminated._tag).toBe("Failure");
      if (terminated._tag === "Failure") expect(terminated.failure.operation).toBe("stream");
    }),
  );

  it.effect("sanitizes provider failure messages", () =>
    Effect.gen(function* () {
      const result = yield* parseImageSse(
        body(
          dataEvent({
            type: "response.failed",
            response: { error: { message: "Bearer provider-secret" } },
          }),
        ),
        "image/png",
      ).pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.operation).toBe("response");
        expect(result.failure.message).not.toContain("provider-secret");
      }
    }),
  );
});

describe("OpenAI image byte and path validation", () => {
  it.effect("rejects noncanonical base64 before image decoding", () => {
    let decodeCount = 0;
    const sharp: SharpAdapterContract = {
      decode: () =>
        Effect.sync(() => {
          decodeCount++;
          return { format: "png" };
        }),
    };
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const output = makeImageOutput({ fs, path: pathService, sharp });
      const result = yield* output
        .validatedGeneratedImage(
          { id: "image", status: "completed", data: "Y Q==", mimeType: "image/png" },
          "png",
        )
        .pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.operation).toBe("response");
      expect(decodeCount).toBe(0);
    }).pipe(provideBuiltLayer(nodePlatformLayer));
  });

  it.effect("keeps input and protected output paths inside the workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const safeFile = yield* SafeFile;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "pi-openai-image-path-test-" });
      const workspace = path.join(root, "workspace");
      const outside = path.join(root, "outside.png");
      yield* fs.makeDirectory(workspace);
      yield* fs.writeFile(outside, bytes("outside"));
      const reader = makeImageInputReader({ fs, path, safeFile, sharp: pngSharp });
      const output = makeImageOutput({ fs, path, sharp: pngSharp });

      const inputResult = yield* reader(["../outside.png"], workspace).pipe(Effect.result);
      const outputResult = yield* output
        .persistImage(path.join(workspace, "..", "escaped"), workspace, bytes("image"), "png", "id")
        .pipe(Effect.result);

      expect(inputResult._tag).toBe("Failure");
      if (inputResult._tag === "Failure") expect(inputResult.failure.operation).toBe("input");
      expect(outputResult._tag).toBe("Failure");
      if (outputResult._tag === "Failure") {
        expect(outputResult.failure._tag).toBe("OpenAIImageError");
        if (outputResult.failure._tag === "OpenAIImageError")
          expect(outputResult.failure.operation).toBe("save");
      }
      expect(yield* fs.exists(path.join(root, "escaped"))).toBe(false);
    }).pipe(provideBuiltLayer(fileLayer)),
  );
});
