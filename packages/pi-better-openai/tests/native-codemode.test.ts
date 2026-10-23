import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer, registerExtensionCommand } from "pi-cosmic-core";
import { fauxCodemodeSession } from "pi-cosmic-core/testing/sdk";
import { registerOpenAIImage } from "../src/image/register.ts";
import { imageResultText } from "../src/image/result-text.ts";
import { OpenAIImageService } from "../src/image/service.ts";
import {
  fail,
  prepareImageArguments,
  type CodexImageResult,
  type OpenAIImageError,
  type ToolParams,
} from "../src/image/types.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const block = { type: "image", data: png, mimeType: "image/png" };
const prompt = "  Draw a comet.\nKeep the label ‘hello’.  ";
const generated = (params: ToolParams, savedPath?: string): CodexImageResult => ({
  id: "image-1",
  status: "completed",
  prompt: params.prompt,
  revisedPrompt: "A comet with a label.",
  data: png,
  mimeType: "image/png",
  ...(savedPath !== undefined && { savedPath }),
  model: "fixture-model",
  imageModel: "fixture-image-model",
  action: params.action ?? "auto",
  outputFormat: "png",
});
const envelope = { contract: "pi-better-openai/image", version: 1, tool: "openai_image" };
const decodeOutput = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const literal = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const print = (expression: string) => `text('IMAGE_RESULT ' + JSON.stringify(${expression}));`;
const output = (text: string) => {
  const line = text.split("\n").find((candidate) => candidate.startsWith("IMAGE_RESULT "));
  expect(line, text).toBeDefined();
  return decodeOutput(line!.slice("IMAGE_RESULT ".length));
};

const nativeImageSession = (
  generate: (params: ToolParams, cwd: string) => Effect.Effect<CodexImageResult, OpenAIImageError>,
) =>
  Effect.gen(function* () {
    const runTool = Effect.runPromiseWith(yield* Effect.context());
    return yield* fauxCodemodeSession({
      prefix: "openai-image-workflow-",
      provider: "openai-image-workflow-test",
      extension: {
        name: "openai-image-workflow-test",
        factory: (cwd) => (pi) => {
          const service = OpenAIImageService.of({
            generate: (params) => generate(prepareImageArguments(params), cwd),
          });
          registerOpenAIImage(
            pi,
            registerExtensionCommand(pi, { name: "openai", description: "OpenAI" }),
            (effect, signal) =>
              runTool(
                effect.pipe(Effect.provideService(OpenAIImageService, service)),
                signal ? { signal } : undefined,
              ),
            () => undefined,
            { noteCwd: () => undefined },
          );
        },
      },
    });
  });

describe("native scripted image workflows", () => {
  it.live(
    "shows save:none images, preserves the prompt and direct details, and persists no duplicate payload",
    () =>
      Effect.gen(function* () {
        const requests: ToolParams[] = [];
        const h = yield* nativeImageSession((params) =>
          Effect.sync(() => {
            requests.push(params);
            return generated(params);
          }),
        );
        const result = yield* h.run(`
          const r = await tools.openai_image({prompt:${literal(prompt)},save:'none'});
          const {image: imageBlock, ...metadata} = r;
          image(imageBlock);
          ${print("metadata")}
        `);
        expect(result.isError, result.text).toBe(false);
        const { data: _data, mimeType: _mimeType, ...metadata } = generated({ prompt });
        expect(output(result.text)).toEqual({ ...envelope, ...metadata });
        expect(result.message.content.filter((part) => part.type === "image")).toEqual([block]);
        expect(result.text).not.toContain(png);
        expect(requests[0]).toEqual({ prompt, save: "none" });

        const direct = yield* h.call("openai_image", { prompt, save: "none" });
        expect(direct.isError, direct.text).toBe(false);
        expect(direct.message.content).toEqual([
          { type: "text", text: imageResultText(generated({ prompt })) },
          block,
        ]);
        expect(direct.message.details).toEqual({ ...metadata, mimeType: "image/png" });
        expect(requests[1]).toEqual({ prompt, save: "none" });

        const persisted = h.session.sessionManager
          .getEntries()
          .filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
        expect(persisted).toHaveLength(2);
        for (const entry of persisted) {
          expect(entry).not.toHaveProperty("message.structuredContent");
          expect(serialize(entry).split(png)).toHaveLength(2);
        }
        expect(serialize(h.session.sessionManager.getEntries()).split(png)).toHaveLength(3);
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
    15_000,
  );

  it.live(
    "rejects owned service failures instead of resolving success-shaped image data",
    () =>
      Effect.gen(function* () {
        const h = yield* nativeImageSession(() =>
          Effect.fail(fail("request", "Image generation unavailable")),
        );
        const result = yield* h.run(`
          let rejected = false;
          try { await tools.openai_image({prompt:'draw a comet'}); }
          catch (error) { rejected = true; text(error.message); }
          ${print("{rejected}")}
        `);
        expect(output(result.text)).toEqual({ rejected: true });
        expect(result.text).toContain("Image generation unavailable");
        expect(result.message.content.some((part) => part.type === "image")).toBe(false);
        const direct = yield* h.call("openai_image", { prompt });
        expect(direct.isError).toBe(true);
        expect(direct.message.content.some((part) => part.type === "image")).toBe(false);
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
    15_000,
  );

  it.live(
    "propagates native script cancellation to the owned image service and permits a later call",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        let blockGeneration = true;
        const h = yield* nativeImageSession((params) =>
          blockGeneration
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(released, undefined)),
              )
            : Effect.succeed(generated(params)),
        );
        const pending = yield* h
          .run("await tools.openai_image({prompt:'draw a comet'});")
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* Effect.promise(() => h.session.abort());
        yield* Fiber.join(pending);
        yield* Deferred.await(released);
        blockGeneration = false;
        const later = yield* h.run(`
          const r = await tools.openai_image({prompt:'try again',save:'none'});
          image(r.image);
          ${print("{id:r.id,status:r.status}")}
        `);
        expect(later.isError, later.text).toBe(false);
        expect(output(later.text)).toEqual({ id: "image-1", status: "completed" });
        expect(later.message.content.filter((part) => part.type === "image")).toEqual([block]);
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
    15_000,
  );
});
