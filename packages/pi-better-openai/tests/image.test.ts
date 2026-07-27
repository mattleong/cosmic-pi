// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/strictEffectProvide:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  AgentDirectory,
  SafeFile,
  StreamingHttpError,
  nodePlatformLayer,
  type StreamingHttpResponse,
} from "pi-cosmic-core";
import {
  makeCapturedTracer,
  streamingHttpTestLayer,
  type StreamingHttpTestRequest,
} from "pi-cosmic-core/testing";
import sharp from "sharp";
import { SharpAdapter } from "../src/boundary/sharp.ts";
import { DEFAULT_COMPACTION_CONFIG, DEFAULT_IMAGE_CONFIG } from "../src/config/index.ts";
import {
  OpenAIImageService,
  registerOpenAIImage,
  type CodexImageResult,
} from "../src/image/index.ts";
import { TOOL_PARAMS } from "../src/image/types.ts";
import { makeProjection, type OpenAIProjection } from "../src/usage/index.ts";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const temp = () => {
  const value = mkdtempSync(join(tmpdir(), "openai-image-effect-"));
  directories.push(value);
  return value;
};
const sse = (events: readonly unknown[]) =>
  Stream.make(
    new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")),
  );
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
const completed = (data = PNG_BASE64) => ({
  type: "response.output_item.done",
  item: { type: "image_generation_call", id: "ig_test", status: "completed", result: data },
});
const httpResponse = (status: number, rawBody: Stream.Stream<Uint8Array, StreamingHttpError>) => ({
  status,
  rawBody,
  discardRawBody: rawBody.pipe(Stream.runDrain),
});

function harness(
  response: (request: StreamingHttpTestRequest) => Effect.Effect<StreamingHttpResponse>,
  timeoutMs = DEFAULT_IMAGE_CONFIG.timeoutMs,
  fileSystemLayer?: Layer.Layer<FileSystem.FileSystem>,
) {
  const cwd = temp();
  const agentDir = temp();
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({ "openai-codex": { type: "oauth", access: "token", accountId: "acct" } }),
  );
  const ctx = {
    cwd,
    hasUI: true,
    model: { provider: "openai-codex", id: "gpt-5.5" },
    modelRegistry: {
      getApiKeyForProvider: () => Promise.resolve(undefined),
      isUsingOAuth: () => true,
    },
    ui: { notify() {} },
  } as unknown as ExtensionContext;
  const config = {
    configPath: join(cwd, ".pi/extensions/pi-better-openai.json"),
    projectConfigPath: "",
    globalConfigPath: "",
    projectConfigExists: true,
    globalConfigExists: false,
    persistState: false,
    active: false,
    desiredActive: false,
    usage: {
      enabled: false,
      refreshIntervalMs: 60_000,
      showOnlyOnSubscriptionModels: true,
      showResetTimes: false,
    },
    footer: { mode: "off" as const },
    compaction: DEFAULT_COMPACTION_CONFIG,
    image: { ...DEFAULT_IMAGE_CONFIG, defaultSave: "none" as const, timeoutMs },
  };
  const projection = makeProjection();
  MutableRef.set(projection, { ...MutableRef.get(projection), config } satisfies OpenAIProjection);
  const context = MutableRef.make(ctx);
  const mockHttp = streamingHttpTestLayer(response);
  const platform = fileSystemLayer
    ? Layer.mergeAll(nodePlatformLayer, mockHttp, fileSystemLayer, AgentDirectory.layer(agentDir))
    : Layer.mergeAll(nodePlatformLayer, mockHttp, AgentDirectory.layer(agentDir));
  const layer = OpenAIImageService.layer({ context, projection, agentDir }).pipe(
    Layer.provide(Layer.merge(SharpAdapter.layer, SafeFile.layer)),
    Layer.provide(platform),
  );
  return {
    cwd,
    agentDir,
    projection,
    effect: <A, E>(program: Effect.Effect<A, E, OpenAIImageService>) =>
      program.pipe(Effect.provide(layer)),
  };
}

describe("Effect-native OpenAI image service", () => {
  it.effect("preserves prompts, uploads edit inputs, consumes SSE, and saves output", () => {
    let request: StreamingHttpTestRequest | undefined;
    const h = harness((input) => {
      request = input;
      return Effect.succeed(httpResponse(200, sse([{ partial_image_b64: "cA==" }, completed()])));
    });
    const input = join(h.cwd, "input.png");
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        sharp({
          create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
        })
          .png()
          .toFile(input),
      );
      const result = yield* OpenAIImageService.use((service) =>
        service.generate({
          prompt: "verbatim user prompt",
          action: "edit",
          images: ["input.png"],
          save: "project",
        }),
      );
      expect(result.prompt).toBe("verbatim user prompt");
      expect(result.data).toBe(PNG_BASE64);
      expect(result.savedPath).toContain(join(h.cwd, ".pi", "generated-images"));
      expect(readFileSync(result.savedPath!).toString("base64")).toBe(PNG_BASE64);
      expect(request?.encodedJsonBody).toMatchObject({
        input: [
          {
            content: [
              { type: "input_text", text: "verbatim user prompt" },
              { type: "input_image" },
            ],
          },
        ],
      });
      const requestBody = request?.encodedJsonBody as {
        input?: Array<{ content?: Array<{ image_url?: string }> }>;
      };
      expect(requestBody.input?.[0]?.content?.[1]?.image_url).toMatch(/^data:image\/png;base64,/);
    }).pipe(h.effect);
  });

  it.effect("maps hostile parameter reflection to a typed boundary failure", () => {
    let calls = 0;
    const h = harness(() => {
      calls++;
      return Effect.succeed(httpResponse(200, sse([completed()])));
    });
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile ownKeys");
        },
      },
    );

    return Effect.gen(function* () {
      const error = yield* OpenAIImageService.use((service) => service.generate(hostile)).pipe(
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "OpenAIImageError",
        operation: "params",
        message: "Invalid OpenAI image parameters.",
      });
      expect(calls).toBe(0);
    }).pipe(h.effect);
  });

  it.effect(
    "rejects workspace escapes, symlinks, oversized files, and Sharp failures before HTTP",
    () => {
      let calls = 0;
      const h = harness(() => {
        calls++;
        return Effect.succeed(httpResponse(200, sse([completed()])));
      });
      const outside = join(temp(), "outside.png");
      writeFileSync(outside, "not-image");
      const bad = join(h.cwd, "bad.txt");
      writeFileSync(bad, "not-image");
      mkdirSync(join(h.cwd, "non-regular.png"));
      const large = join(h.cwd, "large.png");
      writeFileSync(large, "");
      truncateSync(large, 20 * 1024 * 1024 + 1);
      const link = join(h.cwd, "link.png");
      symlinkSync(outside, link);
      return Effect.gen(function* () {
        const service = yield* OpenAIImageService;
        const escape = yield* Effect.flip(service.generate({ prompt: "x", images: [outside] }));
        expect(escape.message).toContain("inside the current workspace");
        const invalid = yield* Effect.flip(service.generate({ prompt: "x", images: ["bad.txt"] }));
        expect(invalid.message).toContain("readable image");
        const nonRegular = yield* Effect.flip(
          service.generate({ prompt: "x", images: ["non-regular.png"] }),
        );
        expect(nonRegular.message).toContain("changed during validation");
        const oversized = yield* Effect.flip(
          service.generate({ prompt: "x", images: ["large.png"] }),
        );
        expect(oversized.message).toContain("too large");
        const linked = yield* Effect.flip(service.generate({ prompt: "x", images: ["link.png"] }));
        expect(linked.message).toContain("inside the current workspace");
        expect(calls).toBe(0);
      }).pipe(h.effect);
    },
  );

  it.effect("rejects a deterministic input swap before external bytes reach HTTP", () => {
    let calls = 0;
    const h = harness(() => {
      calls++;
      return Effect.succeed(httpResponse(200, sse([completed()])));
    });
    const input = join(h.cwd, "swap.png");
    const outside = join(temp(), "outside.png");
    writeFileSync(input, Buffer.from(PNG_BASE64, "base64"));
    writeFileSync(outside, Buffer.from(PNG_BASE64, "base64"));
    const nodeFs = process.getBuiltinModule("node:fs")!;
    const originalLstat = nodeFs.promises.lstat.bind(nodeFs.promises);
    vi.spyOn(nodeFs.promises, "lstat").mockImplementationOnce(((path, options) =>
      originalLstat(path, options).then((stats) => {
        renameSync(input, `${input}.original`);
        symlinkSync(outside, input);
        return stats;
      })) as typeof nodeFs.promises.lstat);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        OpenAIImageService.use((service) =>
          service.generate({ prompt: "x", images: ["swap.png"] }),
        ),
      );
      expect(error.message).toContain("changed during validation");
      expect(calls).toBe(0);
    }).pipe(h.effect);
  });

  it.effect("rejects an ancestor-directory swap before reading external bytes", () => {
    let httpCalls = 0;
    let readCalls = 0;
    const h = harness(() => {
      httpCalls++;
      return Effect.succeed(httpResponse(200, sse([completed()])));
    });
    const insideDirectory = join(h.cwd, "references");
    const outsideDirectory = temp();
    mkdirSync(insideDirectory);
    writeFileSync(join(insideDirectory, "input.png"), Buffer.from(PNG_BASE64, "base64"));
    writeFileSync(join(outsideDirectory, "input.png"), Buffer.from(PNG_BASE64, "base64"));

    const nodeFs = process.getBuiltinModule("node:fs")!;
    const originalLstat = nodeFs.promises.lstat.bind(nodeFs.promises);
    const originalOpen = nodeFs.promises.open.bind(nodeFs.promises);
    vi.spyOn(nodeFs.promises, "lstat").mockImplementationOnce(((path, options) => {
      renameSync(insideDirectory, `${insideDirectory}-original`);
      symlinkSync(outsideDirectory, insideDirectory);
      return originalLstat(path, options);
    }) as typeof nodeFs.promises.lstat);
    vi.spyOn(nodeFs.promises, "open").mockImplementation(((...args) =>
      originalOpen(...args).then((handle) => {
        const originalRead = handle.readFile.bind(handle);
        vi.spyOn(handle, "readFile").mockImplementation(((...readArgs) => {
          readCalls++;
          return originalRead(...readArgs);
        }) as typeof handle.readFile);
        return handle;
      })) as typeof nodeFs.promises.open);

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        OpenAIImageService.use((service) =>
          service.generate({ prompt: "x", images: ["references/input.png"] }),
        ),
      );
      expect(error.message).toContain("changed during validation");
      expect(readCalls).toBe(0);
      expect(httpCalls).toBe(0);
    }).pipe(h.effect);
  });

  it.effect("types non-OK and malformed SSE failures without exposing response bodies", () => {
    const nonOk = harness(() =>
      Effect.succeed(httpResponse(500, sse([{ secret: "Bearer sk-secret" }]))),
    );
    const malformed = harness(() =>
      Effect.succeed(
        httpResponse(200, Stream.make(new TextEncoder().encode("data: not-json\n\n"))),
      ),
    );
    const providerError = harness(() =>
      Effect.succeed(
        httpResponse(
          200,
          sse([{ type: "error", message: "Bearer sk-secret accountId=acct_secret failed" }]),
        ),
      ),
    );
    return Effect.gen(function* () {
      const first = yield* Effect.flip(
        OpenAIImageService.use((service) => service.generate({ prompt: "x" })).pipe(nonOk.effect),
      );
      expect(first.message).toBe("Codex image request failed (500).");
      expect(first.message).not.toContain("secret");
      const second = yield* Effect.flip(
        OpenAIImageService.use((service) => service.generate({ prompt: "x" })).pipe(
          malformed.effect,
        ),
      );
      expect(second.message).toContain("malformed JSON");
      const third = yield* Effect.flip(
        OpenAIImageService.use((service) => service.generate({ prompt: "x" })).pipe(
          providerError.effect,
        ),
      );
      expect(third.message).toContain("Codex image error");
      expect(third.message).not.toContain("sk-secret");
      expect(third.message).not.toContain("acct_secret");
    });
  });

  it.effect("schema-rejects malformed known events and ignores forward-compatible events", () => {
    const malformed = harness(() =>
      Effect.succeed(httpResponse(200, sse([{ type: "response.output_item.done", item: null }]))),
    );
    const future = harness(() =>
      Effect.succeed(httpResponse(200, sse([{ type: "response.future", extra: 1 }, completed()]))),
    );
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        OpenAIImageService.use((service) => service.generate({ prompt: "x" })).pipe(
          malformed.effect,
        ),
      );
      expect(error.message).toContain("malformed event");
      const result = yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "x" }),
      ).pipe(future.effect);
      expect(result.id).toBe("ig_test");
    });
  });

  it.effect("times out an in-progress response stream using the Effect clock", () => {
    const h = harness(() => Effect.succeed(httpResponse(200, Stream.never)), 1);
    return Effect.gen(function* () {
      const fiber = yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "x" }),
      ).pipe(Effect.flip, Effect.forkScoped);
      yield* TestClock.adjust("2 millis");
      const error = yield* Fiber.join(fiber);
      expect(error.operation).toBe("timeout");
    }).pipe(Effect.scoped, h.effect);
  });

  it.effect("interrupts an in-progress response stream", () => {
    let started = false;
    let released = 0;
    const body = Stream.concat(
      Stream.make(new Uint8Array()).pipe(Stream.tap(() => Effect.sync(() => (started = true)))),
      Stream.never,
    ).pipe(Stream.ensuring(Effect.sync(() => released++)));
    const h = harness(() => Effect.succeed(httpResponse(200, body)));
    return Effect.gen(function* () {
      const fiber = yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "x" }),
      ).pipe(Effect.forkScoped);
      while (!started) yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      expect(released).toBe(1);
    }).pipe(Effect.scoped, h.effect);
  });

  it.effect("parses arbitrary chunks, CRLF, comments, and multiline data incrementally", () => {
    const json = JSON.stringify(completed());
    const splitAt = json.indexOf(',"item"') + 1;
    const source = `: comment\r\ndata: ${json.slice(0, splitAt)}\r\ndata: ${json.slice(splitAt)}\r\n\r\n`;
    const bytes = new TextEncoder().encode(source);
    const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
    const h = harness(() => Effect.succeed(httpResponse(200, Stream.fromIterable(chunks))));
    return Effect.gen(function* () {
      const result = yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "chunked" }),
      );
      expect(result.data).toBe(PNG_BASE64);
    }).pipe(h.effect);
  });

  it.effect("returns a completed event immediately and finalizes an open stream", () => {
    let released = 0;
    const first = new TextEncoder().encode(`data: ${JSON.stringify(completed())}\n\n`);
    const body = Stream.concat(Stream.make(first), Stream.never).pipe(
      Stream.ensuring(Effect.sync(() => released++)),
    );
    const h = harness(() => Effect.succeed(httpResponse(200, body)));
    return Effect.gen(function* () {
      const result = yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "done" }),
      );
      expect(result.id).toBe("ig_test");
      expect(released).toBe(1);
    }).pipe(h.effect);
  });

  it.effect("keeps an earlier completion when the later transport would fail", () => {
    const first = Stream.make(new TextEncoder().encode(`data: ${JSON.stringify(completed())}\n\n`));
    const later = Stream.fail(
      new StreamingHttpError({ operation: "stream", message: "late transport failure" }),
    );
    const h = harness(() => Effect.succeed(httpResponse(200, Stream.concat(first, later))));
    return Effect.gen(function* () {
      const result = yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "done" }),
      );
      expect(result.id).toBe("ig_test");
    }).pipe(h.effect);
  });

  it.effect("handles mixed SSE line endings, split UTF-8, and many events in one chunk", () => {
    const event = {
      ...completed(),
      item: { ...completed().item, revised_prompt: "otter 🦦" },
    };
    const comments = Array.from({ length: 2_000 }, (_, index) => `: keepalive ${index}\n\n`).join(
      "",
    );
    const source = `${comments}data: ${JSON.stringify(event)}\r\n\r`;
    const bytes = new TextEncoder().encode(source);
    const emoji = new TextEncoder().encode("🦦");
    const emojiIndex = bytes.findIndex((_value, index) =>
      emoji.every((candidate, offset) => bytes[index + offset] === candidate),
    );
    const body = Stream.fromIterable([
      bytes.slice(0, emojiIndex + 1),
      bytes.slice(emojiIndex + 1, emojiIndex + 3),
      bytes.slice(emojiIndex + 3),
    ]);
    const h = harness(() => Effect.succeed(httpResponse(200, body)));
    return Effect.gen(function* () {
      const result = yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "mixed" }),
      );
      expect(result.revisedPrompt).toBe("otter 🦦");
    }).pipe(h.effect);
  });

  it.effect("fully decodes and rejects truncated input and output images", () => {
    let calls = 0;
    const truncated = Buffer.from(PNG_BASE64, "base64").subarray(0, 50);
    const inputHarness = harness(() => {
      calls++;
      return Effect.succeed(httpResponse(200, sse([completed()])));
    });
    writeFileSync(join(inputHarness.cwd, "truncated.png"), truncated);
    const outputHarness = harness(() =>
      Effect.succeed(httpResponse(200, sse([completed(truncated.toString("base64"))]))),
    );
    return Effect.gen(function* () {
      const inputError = yield* Effect.flip(
        OpenAIImageService.use((service) =>
          service.generate({ prompt: "x", images: ["truncated.png"] }),
        ).pipe(inputHarness.effect),
      );
      expect(inputError.message).toContain("readable image");
      expect(calls).toBe(0);
      const outputError = yield* Effect.flip(
        OpenAIImageService.use((service) => service.generate({ prompt: "x" })).pipe(
          outputHarness.effect,
        ),
      );
      expect(outputError.message).toContain("unreadable image data");
    });
  });

  it.effect("strictly rejects invalid base64 and output-format mismatches", () => {
    const invalid = harness(() => Effect.succeed(httpResponse(200, sse([completed("%%%%")]))));
    return Effect.gen(function* () {
      const badBase64 = yield* Effect.flip(
        OpenAIImageService.use((service) => service.generate({ prompt: "x" })).pipe(invalid.effect),
      );
      expect(badBase64.message).toContain("invalid image base64");

      const jpeg = yield* Effect.tryPromise(() =>
        sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } })
          .jpeg()
          .toBuffer(),
      );
      const mismatch = harness(() =>
        Effect.succeed(httpResponse(200, sse([completed(jpeg.toString("base64"))]))),
      );
      const wrongFormat = yield* Effect.flip(
        OpenAIImageService.use((service) =>
          service.generate({ prompt: "x", outputFormat: "png" }),
        ).pipe(mismatch.effect),
      );
      expect(wrongFormat.message).toContain("when png was requested");
    });
  });

  it.effect("fully decodes every animated GIF frame", () => {
    let calls = 0;
    const h = harness(() => {
      calls++;
      return Effect.succeed(httpResponse(200, sse([completed()])));
    });
    const corruptAnimatedGif = Buffer.from(
      "R0lGODlhAQABAIAAAExpcf8AACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFCgAAACwAAAAAAQABAAACAkwBACH5BAUKAAAALAAAAAABAAEAgExpcQAA/wIC/wEAIfkEBQoAAAAsAAAAAAEAAQCATGlxAP8AAgJMAQA7",
      "base64",
    );
    writeFileSync(join(h.cwd, "corrupt-animated.gif"), corruptAnimatedGif);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        OpenAIImageService.use((service) =>
          service.generate({ prompt: "x", images: ["corrupt-animated.gif"] }),
        ),
      );
      expect(error.message).toContain("readable image");
      expect(calls).toBe(0);
    }).pipe(h.effect);
  });

  it.effect("enforces the exact runtime parameter contract before path or HTTP work", () => {
    let calls = 0;
    const h = harness(() => {
      calls++;
      return Effect.succeed(httpResponse(200, sse([completed()])));
    });
    return Effect.gen(function* () {
      const service = yield* OpenAIImageService;
      const empty = yield* Effect.flip(service.generate({ prompt: "   " }));
      expect(empty.operation).toBe("params");
      const tooMany = yield* Effect.flip(
        service.generate({ prompt: "x", images: ["a", "b", "c", "d", "e", "f"] }),
      );
      expect(tooMany.operation).toBe("params");
      const unknown = yield* Effect.flip(service.generate({ prompt: "x", surprise: true }));
      expect(unknown.operation).toBe("params");
      const longModel = yield* Effect.flip(
        service.generate({ prompt: "x", model: "m".repeat(257) }),
      );
      expect(longModel.operation).toBe("params");
      expect(calls).toBe(0);
    }).pipe(h.effect);
  });

  it.effect("drains non-2xx responses before returning a typed failure", () => {
    let discarded = 0;
    const h = harness(() =>
      Effect.succeed({
        status: 429,
        rawBody: Stream.never,
        discardRawBody: Effect.sync(() => discarded++),
      }),
    );
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        OpenAIImageService.use((service) => service.generate({ prompt: "x" })),
      );
      expect(error.message).toContain("429");
      expect(discarded).toBe(1);
    }).pipe(h.effect);
  });

  it.effect("rejects project output symlink escapes", () => {
    const h = harness(() => Effect.succeed(httpResponse(200, sse([completed()]))));
    const outside = temp();
    mkdirSync(join(h.cwd, ".pi"), { recursive: true });
    symlinkSync(outside, join(h.cwd, ".pi", "generated-images"));
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        OpenAIImageService.use((service) => service.generate({ prompt: "x", save: "project" })),
      );
      expect(error.message).toContain("escapes its protected root");
      expect(readdirSync(outside)).toEqual([]);
    }).pipe(h.effect);
  });

  it.effect("writes no image bytes when the output parent is swapped after temp open", () => {
    const outside = temp();
    let swapped = false;
    const swappingFileSystem = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const built = yield* Layer.build(nodePlatformLayer);
        const base = Context.get(built, FileSystem.FileSystem);
        return FileSystem.FileSystem.of({
          ...base,
          open: (filePath, options) =>
            base.open(filePath, options).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (swapped || !filePath.endsWith(".tmp")) return;
                  swapped = true;
                  const directory = dirname(filePath);
                  const backup = `${directory}-original`;
                  renameSync(directory, backup);
                  symlinkSync(outside, directory);
                }),
              ),
            ),
        });
      }),
    );
    const h = harness(
      () => Effect.succeed(httpResponse(200, sse([completed()]))),
      DEFAULT_IMAGE_CONFIG.timeoutMs,
      swappingFileSystem,
    );
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        OpenAIImageService.use((service) => service.generate({ prompt: "x", save: "project" })),
      );
      expect(error.message).toContain("verify image temporary path");
      expect(swapped).toBe(true);
      expect(readdirSync(outside)).toEqual([]);
    }).pipe(h.effect);
  });

  it.effect("never removes an outside target when the owned temp path becomes a symlink", () => {
    const outside = temp();
    const outsideTarget = join(outside, "outside.png");
    writeFileSync(outsideTarget, "outside-owned");
    let swapped = false;
    const swappingFileSystem = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const built = yield* Layer.build(nodePlatformLayer);
        const base = Context.get(built, FileSystem.FileSystem);
        return FileSystem.FileSystem.of({
          ...base,
          open: (filePath, options) =>
            base.open(filePath, options).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (swapped || !filePath.endsWith(".tmp")) return;
                  swapped = true;
                  rmSync(filePath);
                  symlinkSync(outsideTarget, filePath);
                }),
              ),
            ),
        });
      }),
    );
    const h = harness(
      () => Effect.succeed(httpResponse(200, sse([completed()]))),
      DEFAULT_IMAGE_CONFIG.timeoutMs,
      swappingFileSystem,
    );

    return Effect.gen(function* () {
      const error = yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "x", save: "project" }),
      ).pipe(Effect.flip);

      expect(error.operation).toBe("save");
      expect(swapped).toBe(true);
      expect(readFileSync(outsideTarget, "utf8")).toBe("outside-owned");
    }).pipe(h.effect);
  });

  it.effect("rejects a source swap during hard-link publication", () => {
    const outside = temp();
    const outsideTarget = join(outside, "outside.png");
    writeFileSync(outsideTarget, "outside-owned");
    let swapped = false;
    const swappingFileSystem = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const built = yield* Layer.build(nodePlatformLayer);
        const base = Context.get(built, FileSystem.FileSystem);
        return FileSystem.FileSystem.of({
          ...base,
          link: (source, destination) =>
            Effect.sync(() => {
              if (swapped || !source.endsWith(".tmp")) return;
              swapped = true;
              rmSync(source);
              symlinkSync(outsideTarget, source);
            }).pipe(Effect.andThen(base.link(source, destination))),
        });
      }),
    );
    const h = harness(
      () => Effect.succeed(httpResponse(200, sse([completed()]))),
      DEFAULT_IMAGE_CONFIG.timeoutMs,
      swappingFileSystem,
    );

    return Effect.gen(function* () {
      const error = yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "x", save: "project" }),
      ).pipe(Effect.flip);

      expect(error.message).toContain("owned temporary file");
      expect(swapped).toBe(true);
      expect(readFileSync(outsideTarget, "utf8")).toBe("outside-owned");
      expect(
        readdirSync(join(h.cwd, ".pi", "generated-images")).filter((name) => name.endsWith(".png")),
      ).toEqual([]);
    }).pipe(h.effect);
  });

  it.effect("removes an owned destination when its first post-link stat fails", () => {
    let destinationPath: string | undefined;
    let destinationStatCalls = 0;
    const failingFileSystem = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const built = yield* Layer.build(nodePlatformLayer);
        const base = Context.get(built, FileSystem.FileSystem);
        return FileSystem.FileSystem.of({
          ...base,
          link: (source, destination) =>
            Effect.sync(() => {
              destinationPath = destination;
            }).pipe(Effect.andThen(base.link(source, destination))),
          stat: (filePath) => {
            if (filePath === destinationPath && destinationStatCalls++ === 0)
              return base.stat(`${filePath}.missing`);
            return base.stat(filePath);
          },
        });
      }),
    );
    const h = harness(
      () => Effect.succeed(httpResponse(200, sse([completed()]))),
      DEFAULT_IMAGE_CONFIG.timeoutMs,
      failingFileSystem,
    );

    return Effect.gen(function* () {
      const error = yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "x", save: "project" }),
      ).pipe(Effect.flip);

      expect(error.message).toContain("Unable to verify published image identity");
      expect(destinationPath).toBeTypeOf("string");
      expect(destinationStatCalls).toBe(2);
      expect(
        readdirSync(join(h.cwd, ".pi", "generated-images")).filter((name) => name.endsWith(".png")),
      ).toEqual([]);
    }).pipe(h.effect);
  });

  it.effect("never removes a destination replaced after failed publication verification", () => {
    const outside = temp();
    const outsideTarget = join(outside, "outside.png");
    writeFileSync(outsideTarget, "outside-owned");
    let destinationPath: string | undefined;
    let replaced = false;
    const swappingFileSystem = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const built = yield* Layer.build(nodePlatformLayer);
        const base = Context.get(built, FileSystem.FileSystem);
        return FileSystem.FileSystem.of({
          ...base,
          link: (source, destination) =>
            Effect.sync(() => {
              rmSync(source);
              symlinkSync(outsideTarget, source);
              destinationPath = destination;
            }).pipe(Effect.andThen(base.link(source, destination))),
          stat: (filePath) =>
            base.stat(filePath).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (replaced || filePath !== destinationPath) return;
                  replaced = true;
                  rmSync(filePath);
                  writeFileSync(filePath, "replacement-owned");
                }),
              ),
            ),
        });
      }),
    );
    const h = harness(
      () => Effect.succeed(httpResponse(200, sse([completed()]))),
      DEFAULT_IMAGE_CONFIG.timeoutMs,
      swappingFileSystem,
    );

    return Effect.gen(function* () {
      const error = yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "x", save: "project" }),
      ).pipe(Effect.flip);

      expect(error.message).toContain("owned temporary file");
      expect(replaced).toBe(true);
      expect(destinationPath).toBeTypeOf("string");
      expect(readFileSync(destinationPath!, "utf8")).toBe("replacement-owned");
      expect(readFileSync(outsideTarget, "utf8")).toBe("outside-owned");
    }).pipe(h.effect);
  });

  it.effect("finishes a committed hard-link publication before observing interruption", () => {
    const linked = Deferred.makeUnsafe<void>();
    const releaseLink = Deferred.makeUnsafe<void>();
    const gatedFileSystem = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const built = yield* Layer.build(nodePlatformLayer);
        const base = Context.get(built, FileSystem.FileSystem);
        return FileSystem.FileSystem.of({
          ...base,
          link: (source, destination) =>
            base.link(source, destination).pipe(
              Effect.tap(() => Deferred.succeed(linked, undefined)),
              Effect.andThen(Deferred.await(releaseLink)),
            ),
        });
      }),
    );
    const h = harness(
      () => Effect.succeed(httpResponse(200, sse([completed()]))),
      DEFAULT_IMAGE_CONFIG.timeoutMs,
      gatedFileSystem,
    );

    return Effect.gen(function* () {
      let publishedPath: string | undefined;
      const generation = yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "x", save: "project" }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(linked);
      const imageDirectory = join(h.cwd, ".pi", "generated-images");
      publishedPath = readdirSync(imageDirectory)
        .filter((name) => name.endsWith(".png"))
        .map((name) => join(imageDirectory, name))[0];
      expect(publishedPath).toBeTypeOf("string");
      expect(readFileSync(publishedPath!).toString("base64")).toBe(PNG_BASE64);

      const interruption = yield* Fiber.interrupt(generation).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      expect(interruption.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(releaseLink, undefined);
      yield* Fiber.join(interruption);
      const targetExit = yield* Fiber.await(generation);

      expect(targetExit._tag).toBe("Failure");
      expect(readFileSync(publishedPath!).toString("base64")).toBe(PNG_BASE64);
      expect(readdirSync(imageDirectory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    }).pipe(Effect.scoped, h.effect);
  });

  it.effect("registers temporary-file ownership before observing interruption", () => {
    const statStarted = Deferred.makeUnsafe<void>();
    const releaseStat = Deferred.makeUnsafe<void>();
    const gatedFileSystem = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const built = yield* Layer.build(nodePlatformLayer);
        const base = Context.get(built, FileSystem.FileSystem);
        return FileSystem.FileSystem.of({
          ...base,
          open: (filePath, options) =>
            base.open(filePath, options).pipe(
              Effect.map((file) =>
                filePath.endsWith(".tmp")
                  ? {
                      ...file,
                      stat: Deferred.succeed(statStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseStat)),
                        Effect.andThen(file.stat),
                      ),
                    }
                  : file,
              ),
            ),
        });
      }),
    );
    const h = harness(
      () => Effect.succeed(httpResponse(200, sse([completed()]))),
      DEFAULT_IMAGE_CONFIG.timeoutMs,
      gatedFileSystem,
    );

    return Effect.gen(function* () {
      const generation = yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "x", save: "project" }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(statStarted);
      const interruption = yield* Fiber.interrupt(generation).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      expect(interruption.pollUnsafe()).toBeUndefined();

      yield* Deferred.succeed(releaseStat, undefined);
      yield* Fiber.join(interruption);
      expect((yield* Fiber.await(generation))._tag).toBe("Failure");
      expect(readdirSync(join(h.cwd, ".pi", "generated-images"))).toEqual([]);
    }).pipe(Effect.scoped, h.effect);
  });

  it.effect("fails before HTTP when credentials are missing", () => {
    let calls = 0;
    const h = harness(() => {
      calls++;
      return Effect.succeed(httpResponse(200, sse([completed()])));
    });
    rmSync(join(h.agentDir, "auth.json"));
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        OpenAIImageService.use((service) => service.generate({ prompt: "x" })),
      );
      expect(error.operation).toBe("auth");
      expect(calls).toBe(0);
    }).pipe(h.effect);
  });

  it.effect("treats DONE without a completed image as a typed failure", () => {
    const body = Stream.make(new TextEncoder().encode("data: [DONE]\r\r"));
    const h = harness(() => Effect.succeed(httpResponse(200, body)));
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        OpenAIImageService.use((service) => service.generate({ prompt: "x" })),
      );
      expect(error.message).toContain("No completed image_generation_call");
    }).pipe(h.effect);
  });

  it.effect("surfaces sanitized response.failed events", () => {
    const h = harness(() =>
      Effect.succeed(
        httpResponse(
          200,
          sse([
            {
              type: "response.failed",
              response: { error: { message: "Bearer sk-secret accountId=acct_hidden failed" } },
            },
          ]),
        ),
      ),
    );
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        OpenAIImageService.use((service) => service.generate({ prompt: "x" })),
      );
      expect(error.message).not.toContain("sk-secret");
      expect(error.message).not.toContain("acct_hidden");
    }).pipe(h.effect);
  });

  it.effect("captures stable image spans without prompts, paths, tokens, or account IDs", () => {
    const captured = makeCapturedTracer();
    const h = harness(() => Effect.succeed(httpResponse(200, sse([completed()]))));
    return Effect.gen(function* () {
      yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "secret prompt sk-secret accountId=acct_hidden" }),
      );
      const names = captured.spans.map((span) => span.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "pi-better-openai.image.request",
          "pi-better-openai.image.stream",
          "pi-better-openai.image.convert",
        ]),
      );
      const telemetry = JSON.stringify(
        captured.spans.map((span) => ({ name: span.name, attributes: [...span.attributes] })),
      );
      expect(telemetry).not.toContain("secret prompt");
      expect(telemetry).not.toContain("sk-secret");
      expect(telemetry).not.toContain("acct_hidden");
      expect(telemetry).not.toContain(h.cwd);
    }).pipe(h.effect, Effect.provide(captured.layer));
  });

  it.effect("ignores provider data-URL MIME and enforces requested bytes", () => {
    const h = harness(() =>
      Effect.succeed(httpResponse(200, sse([completed(`data:image/jpeg;base64,${PNG_BASE64}`)]))),
    );
    return Effect.gen(function* () {
      const result = yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "x", outputFormat: "png" }),
      );
      expect(result.mimeType).toBe("image/png");
    }).pipe(h.effect);
  });

  it.effect("bounds provider IDs in persisted filenames", () => {
    const hugeId = `ig_${"x".repeat(5_000)}`;
    const h = harness(() =>
      Effect.succeed(
        httpResponse(
          200,
          sse([
            {
              type: "response.output_item.done",
              item: {
                type: "image_generation_call",
                id: hugeId,
                status: "completed",
                result: PNG_BASE64,
              },
            },
          ]),
        ),
      ),
    );
    const outside = temp();
    return Effect.gen(function* () {
      const result = yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "x", save: "custom", saveDir: outside }),
      );
      expect(result.savedPath!.split("/").pop()!.length).toBeLessThan(180);
    }).pipe(h.effect);
  });

  it.effect("returns the exact registered Pi tool contract and current callback context", () => {
    type RegisteredTool = {
      parameters: unknown;
      execute(
        id: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: ((update: unknown) => void) | undefined,
        ctx: ExtensionContext,
      ): Promise<unknown>;
    };
    let registered: RegisteredTool | undefined;
    let currentContext: ExtensionContext | undefined;
    const pi = {
      registerTool(tool: unknown) {
        registered = tool as RegisteredTool;
      },
      registerCommand() {},
      registerMessageRenderer() {},
    } as unknown as ExtensionAPI;
    const result: CodexImageResult = {
      id: "ig_contract",
      status: "completed",
      prompt: "verbatim",
      data: PNG_BASE64,
      mimeType: "image/png",
      model: "gpt-5.5",
      action: "auto",
      outputFormat: "png",
    };
    const run = <A, E>(_effect: Effect.Effect<A, E, OpenAIImageService>): Promise<A> =>
      Promise.resolve(result as unknown as A);
    registerOpenAIImage(pi, run, (ctx) => {
      currentContext = ctx;
    });
    const ctx = { model: { id: "gpt-5.5" } } as ExtensionContext;
    const onUpdate = vi.fn();
    return Effect.gen(function* () {
      const output = yield* Effect.tryPromise(() =>
        registered!.execute("call", { prompt: "verbatim" }, undefined, onUpdate, ctx),
      );
      expect(currentContext).toBe(ctx);
      expect(registered!.parameters).toEqual(TOOL_PARAMS);
      expect(TOOL_PARAMS.properties.prompt).toMatchObject({
        minLength: 1,
        maxLength: 32_768,
        pattern: "\\S",
      });
      expect(TOOL_PARAMS.properties.images).toMatchObject({
        maxItems: 5,
        items: { minLength: 1, maxLength: 4_096, pattern: "\\S" },
      });
      expect(TOOL_PARAMS.additionalProperties).toBe(false);
      expect(onUpdate).toHaveBeenCalledWith({
        content: [{ type: "text", text: expect.stringContaining("gpt-5.5") }],
        details: undefined,
      });
      expect(output).toEqual({
        content: [
          { type: "text", text: expect.stringContaining("Prompt: verbatim") },
          { type: "image", data: PNG_BASE64, mimeType: "image/png" },
        ],
        details: result,
      });
    });
  });

  it.effect("never clobbers an existing destination when nonce generation collides", () => {
    const h = harness(() => Effect.succeed(httpResponse(200, sse([completed()]))));
    const fixedRandom = {
      nextIntUnsafe: () => 0,
      nextDoubleUnsafe: () => 0,
    };
    const generate = OpenAIImageService.use((service) =>
      service.generate({ prompt: "x", save: "project" }),
    ).pipe(Effect.provideService(Random.Random, fixedRandom));
    return Effect.gen(function* () {
      const first = yield* generate;
      const before = readFileSync(first.savedPath!);
      const collision = yield* Effect.flip(generate);
      expect(collision.message).toContain("without clobbering");
      expect(readFileSync(first.savedPath!)).toEqual(before);
      expect(readdirSync(join(h.cwd, ".pi", "generated-images"))).toHaveLength(1);
    }).pipe(h.effect);
  });

  it.effect("never removes a pre-existing temporary-file candidate", () => {
    const h = harness(() => Effect.succeed(httpResponse(200, sse([completed()]))));
    const fixedRandom = {
      nextIntUnsafe: () => 0,
      nextDoubleUnsafe: () => 0,
    };
    const generate = OpenAIImageService.use((service) =>
      service.generate({ prompt: "x", save: "project" }),
    ).pipe(Effect.provideService(Random.Random, fixedRandom));
    return Effect.gen(function* () {
      const first = yield* generate;
      const temporaryCandidate = `${first.savedPath}.0000000000000000.tmp`;
      writeFileSync(temporaryCandidate, "owned by another writer");

      const collision = yield* Effect.flip(generate);

      expect(collision.message).toContain("Unable to create image temporary file");
      expect(readFileSync(temporaryCandidate, "utf8")).toBe("owned by another writer");
    }).pipe(h.effect);
  });

  it.effect("reports a successful publication when temporary cleanup defects", () => {
    const failingCleanupFileSystem = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const built = yield* Layer.build(nodePlatformLayer);
        const base = Context.get(built, FileSystem.FileSystem);
        return FileSystem.FileSystem.of({
          ...base,
          remove: (filePath, options) =>
            filePath.endsWith(".tmp")
              ? Effect.die("injected cleanup failure")
              : base.remove(filePath, options),
        });
      }),
    );
    const h = harness(
      () => Effect.succeed(httpResponse(200, sse([completed()]))),
      DEFAULT_IMAGE_CONFIG.timeoutMs,
      failingCleanupFileSystem,
    );

    return Effect.gen(function* () {
      const result = yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "x", save: "project" }),
      );

      expect(result.savedPath).toBeTypeOf("string");
      expect(readFileSync(result.savedPath!).toString("base64")).toBe(PNG_BASE64);
      expect(readdirSync(join(h.cwd, ".pi", "generated-images"))).toHaveLength(2);
    }).pipe(h.effect);
  });

  it.effect("maps a temporary-file close defect before publication and cleans up", () => {
    const failingCloseFileSystem = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const built = yield* Layer.build(nodePlatformLayer);
        const base = Context.get(built, FileSystem.FileSystem);
        return FileSystem.FileSystem.of({
          ...base,
          open: (filePath, options) =>
            base
              .open(filePath, options)
              .pipe(
                Effect.tap(() =>
                  filePath.endsWith(".tmp")
                    ? Effect.addFinalizer(() => Effect.die("injected close failure"))
                    : Effect.void,
                ),
              ),
        });
      }),
    );
    const h = harness(
      () => Effect.succeed(httpResponse(200, sse([completed()]))),
      DEFAULT_IMAGE_CONFIG.timeoutMs,
      failingCloseFileSystem,
    );

    return Effect.gen(function* () {
      const failure = yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "x", save: "project" }),
      ).pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "OpenAIImageError",
        operation: "save",
        message: "Unable to close image temporary file.",
      });
      expect(readdirSync(join(h.cwd, ".pi", "generated-images"))).toEqual([]);
    }).pipe(h.effect);
  });

  it.effect("attempts temporary-file cleanup when file-scope release defects", () => {
    let temporaryOpened = false;
    const failingReleaseFileSystem = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const built = yield* Layer.build(nodePlatformLayer);
        const base = Context.get(built, FileSystem.FileSystem);
        return FileSystem.FileSystem.of({
          ...base,
          open: (filePath, options) =>
            base.open(filePath, options).pipe(
              Effect.tap(() => {
                if (!filePath.endsWith(".tmp")) return Effect.void;
                temporaryOpened = true;
                return Effect.addFinalizer(() => Effect.die("injected close failure"));
              }),
            ),
          realPath: (filePath) =>
            temporaryOpened && filePath.endsWith(".tmp")
              ? Effect.die("injected verification failure")
              : base.realPath(filePath),
        });
      }),
    );
    const h = harness(
      () => Effect.succeed(httpResponse(200, sse([completed()]))),
      DEFAULT_IMAGE_CONFIG.timeoutMs,
      failingReleaseFileSystem,
    );
    const fixedRandom = {
      nextIntUnsafe: () => 0,
      nextDoubleUnsafe: () => 0,
    };
    return Effect.gen(function* () {
      const result = yield* OpenAIImageService.use((service) =>
        service.generate({ prompt: "x", save: "project" }),
      ).pipe(Effect.provideService(Random.Random, fixedRandom), Effect.exit);

      expect(result._tag).toBe("Failure");
      expect(temporaryOpened).toBe(true);
      expect(readdirSync(join(h.cwd, ".pi", "generated-images"))).toEqual([]);
    }).pipe(h.effect);
  });

  it.effect("supports arbitrary custom roots with atomic collision-safe names", () => {
    const h = harness(() => Effect.succeed(httpResponse(200, sse([completed()]))));
    const outside = temp();
    return Effect.gen(function* () {
      const service = yield* OpenAIImageService;
      const first = yield* service.generate({
        prompt: "x",
        save: "custom",
        saveDir: outside,
      });
      const second = yield* service.generate({
        prompt: "x",
        save: "custom",
        saveDir: outside,
      });
      expect(first.savedPath).not.toBe(second.savedPath);
      const names = readdirSync(outside);
      expect(names).toHaveLength(2);
      expect(names.every((name) => !name.endsWith(".tmp"))).toBe(true);
    }).pipe(h.effect);
  });
});
