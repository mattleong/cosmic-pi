import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  AgentDirectory,
  JsonDocumentStore,
  maskIdentifier,
  SafeFile,
  sanitizeDiagnosticError,
  StreamingHttpClient,
  type StreamingHttpError,
} from "pi-cosmic-core";
import { SharpAdapter } from "../boundary/sharp.ts";
import { getCodexCredentials } from "../auth/codex-auth.ts";
import { decodeImageStreamEvent, ImageRequestSchema } from "./protocol.ts";
import type { OpenAIProjection } from "../usage/index.ts";
import {
  buildRequest,
  decodeBase64,
  extensionForFormat,
  extractImageFromEvent,
  imageMimeType,
  isInside,
  resolveImageConfig,
  resolveModel,
} from "./helpers.ts";
import {
  CODEX_RESPONSES_URL,
  DEFAULT_TIMEOUT_MS,
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_INPUTS,
  MAX_IMAGE_RESPONSE_BYTES,
  MAX_SSE_EVENT_CHARS,
  MAX_TOTAL_IMAGE_INPUT_BYTES,
  OpenAIImageError,
  SUPPORTED_INPUT_IMAGE_FORMATS,
  TOOL_PARAM_KEYS,
  ToolParamsSchema,
  fail,
  type CodexImageResult,
  type ExtractedImageResult,
  type ImageGenerationDebug,
  type ImageOutputFormat,
  type ImageState,
} from "./types.ts";

export interface OpenAIImageServiceShape {
  readonly generate: (params: unknown) => Effect.Effect<CodexImageResult, OpenAIImageError>;
  readonly debug: () => Effect.Effect<ImageGenerationDebug>;
}
export class OpenAIImageService extends Context.Service<
  OpenAIImageService,
  OpenAIImageServiceShape
>()("pi-better-openai/image/service/OpenAIImageService") {
  static layer(options: {
    readonly context: MutableRef.MutableRef<ExtensionContext>;
    readonly projection: MutableRef.MutableRef<OpenAIProjection>;
    readonly agentDir?: string;
  }) {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const http = yield* StreamingHttpClient;
        const safeFile = yield* SafeFile;
        const sharp = yield* SharpAdapter;
        const documents = yield* JsonDocumentStore;
        const agentDir = options.agentDir ?? (yield* AgentDirectory);
        const authPath = path.join(agentDir, "auth.json");
        const customSaveDir = yield* Config.option(Config.string("PI_IMAGE_SAVE_DIR"));
        const homeDirectory = yield* Config.option(Config.string("HOME"));
        const state = yield* Ref.make<ImageState>({});
        const credentialsFor = (ctx: Pick<ExtensionContext, "modelRegistry">) =>
          getCodexCredentials(authPath, ctx).pipe(
            Effect.provideService(JsonDocumentStore, documents),
          );

        const imageError = (operation: string, message: string) => () => fail(operation, message);
        const validateInput = Effect.fn("OpenAIImage.validateInput")(function* (
          inputPath: string,
          realWorkspace: string,
        ) {
          const realInput = yield* fs
            .realPath(inputPath)
            .pipe(
              Effect.mapError(
                imageError(
                  "input",
                  `Image input must be a file inside the current workspace: ${inputPath}`,
                ),
              ),
            );
          if (!isInside(path, realWorkspace, realInput))
            return yield* fail(
              "input",
              `Image input must be a file inside the current workspace: ${inputPath}`,
            );
          const verified = yield* safeFile
            .readContainedRegularFile(realInput, realWorkspace, MAX_IMAGE_INPUT_BYTES)
            .pipe(
              Effect.mapError((error) =>
                fail(
                  "input",
                  error.operation === "size"
                    ? `Image input is too large (max 20 MB): ${inputPath}`
                    : `Image input changed during validation: ${inputPath}`,
                ),
              ),
            );
          const metadata = yield* sharp
            .decode(verified.bytes)
            .pipe(
              Effect.mapError(
                imageError("sharp", `Image input is not a readable image: ${inputPath}`),
              ),
            );
          if (!metadata.format || !SUPPORTED_INPUT_IMAGE_FORMATS.has(metadata.format))
            return yield* fail("input", `Image input is not a readable image: ${inputPath}`);
          return {
            path: verified.path,
            data: verified.bytes,
            size: verified.bytes.byteLength,
            mimeType: imageMimeType(inputPath, metadata.format),
          };
        });
        const readInputs = Effect.fn("OpenAIImage.readInputs")(function* (
          rawPaths: readonly string[] | undefined,
          cwd: string,
        ) {
          const workspace = path.resolve(cwd);
          const realWorkspace = yield* fs
            .realPath(workspace)
            .pipe(Effect.catch(() => Effect.succeed(workspace)));
          const seen = new Set<string>();
          const validated: Array<{
            path: string;
            data: Uint8Array;
            size: number;
            mimeType: string;
          }> = [];
          let total = 0;
          for (const raw of rawPaths ?? []) {
            const trimmed = raw.trim();
            if (!trimmed) continue;
            const candidate = path.resolve(workspace, trimmed);
            if (!isInside(path, workspace, candidate))
              return yield* fail(
                "input",
                `Image input must be a file inside the current workspace: ${candidate}`,
              );
            const input = yield* validateInput(candidate, realWorkspace);
            if (seen.has(input.path)) continue;
            if (validated.length >= MAX_IMAGE_INPUTS)
              return yield* fail("input", `Too many image inputs (max ${MAX_IMAGE_INPUTS}).`);
            total += input.size;
            if (total > MAX_TOTAL_IMAGE_INPUT_BYTES)
              return yield* fail("input", "Image inputs are too large in total (max 50 MB).");
            seen.add(input.path);
            validated.push(input);
          }
          return validated.map((input) => ({
            path: input.path,
            mimeType: input.mimeType,
            data: Buffer.from(input.data).toString("base64"),
          }));
        });
        const parseSse = Effect.fn("OpenAIImage.parseSse")(function* (
          body: Stream.Stream<Uint8Array, StreamingHttpError>,
          mimeType: string,
        ) {
          const fallbackId = `ig_${(yield* Random.nextIntBetween(0, 0xffff_ffff)).toString(16).padStart(8, "0")}`;
          let totalBytes = 0;
          let buffer = "";
          let previousWasCarriageReturn = false;
          let completed: ExtractedImageResult | undefined;
          let providerFailure: OpenAIImageError | undefined;
          let terminated = false;

          const processBlock = Effect.fn("OpenAIImage.processSseBlock")(function* (block: string) {
            if (block.length > MAX_SSE_EVENT_CHARS)
              return yield* fail("stream", "Codex image response event was too large.");
            const data = block
              .split(/\r\n|\n|\r/)
              .filter((line) => !line.startsWith(":"))
              .filter((line) => line === "data" || line.startsWith("data:"))
              .map((line) => (line === "data" ? "" : line.slice(5).replace(/^ /, "")))
              .join("\n")
              .trim();
            if (!data) return true;
            if (data === "[DONE]") {
              terminated = true;
              return false;
            }
            const rawEvent = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Unknown),
            )(data).pipe(
              Effect.mapError(() =>
                fail("stream", "Codex image response contained malformed JSON."),
              ),
            );
            const event: unknown = yield* decodeImageStreamEvent(rawEvent).pipe(
              Effect.mapError(() =>
                fail("stream", "Codex image response contained a malformed event."),
              ),
            );
            const image = extractImageFromEvent(event, mimeType, fallbackId);
            if (image?.data && image.status === "completed") {
              completed = image;
              return false;
            }
            if (Predicate.isObject(event) && event.type === "response.failed") {
              const response = Predicate.isObject(event.response) ? event.response : undefined;
              const error = Predicate.isObject(response?.error) ? response.error : undefined;
              providerFailure = fail(
                "response",
                sanitizeDiagnosticError(
                  typeof error?.message === "string"
                    ? error.message
                    : "Codex image request failed.",
                ),
              );
              return false;
            }
            if (Predicate.isObject(event) && event.type === "error") {
              providerFailure = fail(
                "response",
                `Codex image error: ${sanitizeDiagnosticError(typeof event.message === "string" ? event.message : "Codex image request failed.")}`,
              );
              return false;
            }
            return true;
          });

          const appendNormalized = (chunk: string) => {
            let normalized = "";
            for (const character of chunk) {
              if (character === "\r") {
                normalized += "\n";
                previousWasCarriageReturn = true;
              } else if (character === "\n" && previousWasCarriageReturn) {
                previousWasCarriageReturn = false;
              } else {
                normalized += character;
                previousWasCarriageReturn = false;
              }
            }
            buffer += normalized;
          };
          const drainCompleteEvents = Effect.fn("OpenAIImage.drainSseEvents")(function* () {
            while (true) {
              const separator = buffer.indexOf("\n\n");
              if (separator < 0) break;
              const block = buffer.slice(0, separator);
              buffer = buffer.slice(separator + 2);
              if (!(yield* processBlock(block))) return false;
            }
            if (buffer.length > MAX_SSE_EVENT_CHARS)
              return yield* fail("stream", "Codex image response event was too large.");
            return true;
          });
          const bounded = body.pipe(
            Stream.mapEffect((bytes) => {
              totalBytes += bytes.byteLength;
              return totalBytes > MAX_IMAGE_RESPONSE_BYTES
                ? Effect.fail(fail("stream", "Codex image response was too large."))
                : Effect.succeed(bytes);
            }),
            Stream.decodeText,
          );
          yield* bounded.pipe(
            Stream.runForEachWhile((chunk) =>
              Effect.gen(function* () {
                appendNormalized(chunk);
                return yield* drainCompleteEvents();
              }),
            ),
            Effect.mapError((error) =>
              error instanceof OpenAIImageError
                ? error
                : fail("stream", "Codex image response stream failed."),
            ),
          );
          if (!completed && !providerFailure && !terminated && buffer.trim())
            yield* processBlock(buffer);
          if (completed) return completed;
          if (providerFailure) return yield* providerFailure;
          return yield* fail(
            "stream",
            "No completed image_generation_call result returned by Codex.",
          );
        });
        const validatedGeneratedImage = Effect.fn("OpenAIImage.validateGeneratedImage")(function* (
          parsed: ExtractedImageResult,
          outputFormat: ImageOutputFormat,
        ) {
          const bytes = decodeBase64(parsed.data);
          if (!bytes) return yield* fail("response", "Codex returned invalid image base64.");
          const metadata = yield* sharp
            .decode(bytes)
            .pipe(Effect.mapError(imageError("response", "Codex returned unreadable image data.")));
          const expected = outputFormat === "jpeg" ? "jpeg" : outputFormat;
          const actual = metadata.format === "jpg" ? "jpeg" : metadata.format;
          if (actual !== expected)
            return yield* fail(
              "response",
              `Codex returned ${actual ?? "unknown"} image data when ${expected} was requested.`,
            );
          return {
            ...parsed,
            data: Buffer.from(bytes).toString("base64"),
            mimeType: imageMimeType(`image.${outputFormat}`, outputFormat),
            bytes,
          };
        });
        const persistImage = Effect.fn("OpenAIImage.persistImage")(function* (
          requestedDirectory: string,
          protectedBase: string | undefined,
          bytes: Uint8Array,
          outputFormat: ImageOutputFormat,
          providerId: string,
        ) {
          let canonicalBase: string | undefined;
          if (protectedBase) {
            canonicalBase = yield* fs
              .realPath(protectedBase)
              .pipe(
                Effect.mapError(imageError("save", "Unable to resolve protected output root.")),
              );
            const relative = path.relative(
              path.resolve(protectedBase),
              path.resolve(requestedDirectory),
            );
            if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`))
              return yield* fail("save", "Image output directory escapes its protected root.");
            let existingAncestor = path.resolve(requestedDirectory);
            while (!(yield* fs.exists(existingAncestor))) {
              const parent = path.dirname(existingAncestor);
              if (parent === existingAncestor)
                return yield* fail("save", "Unable to resolve image output directory.");
              existingAncestor = parent;
            }
            const canonicalAncestor = yield* fs
              .realPath(existingAncestor)
              .pipe(Effect.mapError(imageError("save", "Unable to inspect image output path.")));
            if (
              canonicalAncestor !== canonicalBase &&
              !isInside(path, canonicalBase, canonicalAncestor)
            )
              return yield* fail("save", "Image output directory escapes its protected root.");
          }
          yield* fs
            .makeDirectory(requestedDirectory, { recursive: true })
            .pipe(Effect.mapError(imageError("save", "Unable to create image output directory.")));
          const canonicalDirectory = yield* fs
            .realPath(requestedDirectory)
            .pipe(Effect.mapError(imageError("save", "Unable to resolve image output directory.")));
          if (
            canonicalBase &&
            canonicalDirectory !== canonicalBase &&
            !isInside(path, canonicalBase, canonicalDirectory)
          )
            return yield* fail("save", "Image output directory escapes its protected root.");
          const now = yield* Clock.currentTimeMillis;
          const stamp = DateTime.formatIso(DateTime.makeUnsafe(now)).replace(/[:.]/g, "-");
          const safeId = providerId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "image";
          const nonce = [
            yield* Random.nextIntBetween(0, 0xffff_ffff),
            yield* Random.nextIntBetween(0, 0xffff_ffff),
          ]
            .map((value) => value.toString(16).padStart(8, "0"))
            .join("");
          const destination = path.join(
            canonicalDirectory,
            `openai-image-${stamp}-${safeId}-${nonce}.${extensionForFormat(outputFormat)}`,
          );
          const temporary = `${destination}.${nonce}.tmp`;
          let ownedIdentity: { readonly dev: number; readonly ino: number } | undefined;
          let publishedIdentity:
            | { readonly type: string; readonly dev: number; readonly ino: number }
            | undefined;
          const removeOwnedTemporary = Effect.gen(function* () {
            if (!ownedIdentity) return;
            const visible = yield* fs.stat(temporary);
            const visibleInode = Option.getOrUndefined(visible.ino);
            if (
              visible.type === "File" &&
              visibleInode === ownedIdentity.ino &&
              visible.dev === ownedIdentity.dev
            )
              yield* fs.remove(temporary);
          }).pipe(Effect.catchCause(() => Effect.void));
          const removePublishedDestination = Effect.gen(function* () {
            if (!publishedIdentity) return;
            const visible = yield* fs.stat(destination);
            const visibleInode = Option.getOrUndefined(visible.ino);
            if (
              visible.type === publishedIdentity.type &&
              visibleInode === publishedIdentity.ino &&
              visible.dev === publishedIdentity.dev
            )
              yield* fs.remove(destination);
          }).pipe(Effect.catchCause(() => Effect.void));
          const verifyPublicationSource = Effect.fn("OpenAIImage.verifyPublicationSource")(
            function* () {
              if (!ownedIdentity)
                return yield* fail("save", "Unable to verify image temporary file identity.");
              const actualTemporary = yield* fs
                .realPath(temporary)
                .pipe(
                  Effect.mapError(imageError("save", "Unable to verify image temporary path.")),
                );
              const visible = yield* fs
                .stat(temporary)
                .pipe(
                  Effect.mapError(imageError("save", "Unable to verify image temporary file.")),
                );
              const visibleInode = Option.getOrUndefined(visible.ino);
              if (
                visible.type !== "File" ||
                visibleInode !== ownedIdentity.ino ||
                visible.dev !== ownedIdentity.dev ||
                !isInside(path, canonicalDirectory, actualTemporary) ||
                (canonicalBase && !isInside(path, canonicalBase, actualTemporary))
              )
                return yield* fail("save", "Image temporary file escaped its protected root.");
            },
          );
          const acquireTemporary = Effect.gen(function* () {
            const fileScope = yield* Scope.make();
            return yield* Effect.gen(function* () {
              const file = yield* fs
                .open(temporary, { flag: "wx" })
                .pipe(
                  Effect.mapError(imageError("save", "Unable to create image temporary file.")),
                  Effect.provideService(Scope.Scope, fileScope),
                );
              const opened = yield* file.stat.pipe(
                Effect.mapError(
                  imageError("save", "Unable to verify image temporary file identity."),
                ),
              );
              const openedInode = Option.getOrUndefined(opened.ino);
              if (opened.type !== "File" || openedInode === undefined)
                return yield* fail("save", "Unable to verify image temporary file identity.");
              ownedIdentity = { dev: opened.dev, ino: openedInode };
              return { file, fileScope };
            }).pipe(
              Effect.onError((cause) =>
                Scope.close(fileScope, Exit.failCause(cause)).pipe(
                  Effect.catchCause(() => Effect.void),
                  Effect.ensuring(removeOwnedTemporary),
                ),
              ),
            );
          });
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.acquireUseRelease(
              acquireTemporary,
              ({ file, fileScope }) =>
                restore(
                  Effect.gen(function* () {
                    yield* verifyPublicationSource();
                    yield* file
                      .writeAll(bytes)
                      .pipe(Effect.mapError(imageError("save", "Unable to save generated image.")));
                    yield* file.sync.pipe(
                      Effect.mapError(imageError("save", "Unable to sync generated image.")),
                    );
                    yield* Scope.close(fileScope, Exit.void).pipe(
                      Effect.catchDefect(() =>
                        Effect.fail(fail("save", "Unable to close image temporary file.")),
                      ),
                    );
                  }),
                ).pipe(
                  Effect.andThen(
                    Effect.gen(function* () {
                      yield* verifyPublicationSource();
                      let linked = false;
                      yield* Effect.gen(function* () {
                        yield* fs
                          .link(temporary, destination)
                          .pipe(
                            Effect.mapError(
                              imageError(
                                "save",
                                "Unable to publish generated image without clobbering.",
                              ),
                            ),
                          );
                        linked = true;
                        const published = yield* fs
                          .stat(destination)
                          .pipe(
                            Effect.mapError(
                              imageError("save", "Unable to verify published image identity."),
                            ),
                          );
                        const publishedInode = Option.getOrUndefined(published.ino);
                        if (publishedInode !== undefined)
                          publishedIdentity = {
                            type: published.type,
                            dev: published.dev,
                            ino: publishedInode,
                          };
                        if (
                          !ownedIdentity ||
                          published.type !== "File" ||
                          publishedInode !== ownedIdentity.ino ||
                          published.dev !== ownedIdentity.dev
                        )
                          return yield* fail(
                            "save",
                            "Published image did not match the owned temporary file.",
                          );
                      }).pipe(
                        Effect.onError(() => (linked ? removePublishedDestination : Effect.void)),
                      );
                    }).pipe(Effect.uninterruptible),
                  ),
                ),
              ({ fileScope }, exit) =>
                Scope.close(fileScope, exit).pipe(
                  Effect.catchCause(() => Effect.void),
                  Effect.ensuring(removeOwnedTemporary),
                ),
            ).pipe(Effect.as(destination)),
          );
        });
        const generate = Effect.fn("OpenAIImage.generate")(function* (rawParams: unknown) {
          yield* Ref.set(state, { lastStatus: "requesting" });
          const parameterKeys = yield* Effect.try({
            try: () => (Predicate.isObject(rawParams) ? Object.keys(rawParams) : undefined),
            catch: imageError("params", "Invalid OpenAI image parameters."),
          });
          if (!parameterKeys || parameterKeys.some((key) => !TOOL_PARAM_KEYS.has(key)))
            return yield* fail("params", "Invalid OpenAI image parameters.");
          const params = yield* Schema.decodeUnknownEffect(ToolParamsSchema)(rawParams).pipe(
            Effect.mapError(imageError("params", "Invalid OpenAI image parameters.")),
          );
          const ctx = MutableRef.get(options.context);
          const cfg = MutableRef.get(options.projection).config;
          if (!cfg) return yield* fail("config", "Better OpenAI session has not started.");
          if (!cfg.image.enabled)
            return yield* fail("config", "OpenAI image generation is disabled in config.");
          const cwd = yield* Effect.try({
            try: () => ctx.cwd,
            catch: imageError("context", "Unable to read the Pi working directory."),
          });
          const model = yield* Effect.try({
            try: () => resolveModel(params, ctx, cfg),
            catch: imageError("context", "Unable to read the Pi model context."),
          });
          const { action, outputFormat, save } = resolveImageConfig(cfg, params);
          const customDirectory =
            params.saveDir?.trim() || Option.getOrUndefined(customSaveDir)?.trim();
          const resolveCustomDirectory = (directory: string | undefined) => {
            if (!directory) return undefined;
            const home = Option.getOrUndefined(homeDirectory);
            if (directory === "~") return home;
            if (directory.startsWith("~/"))
              return home ? path.resolve(home, directory.slice(2)) : undefined;
            return path.resolve(cwd, directory);
          };
          const saveDir =
            save === "none"
              ? undefined
              : save === "project"
                ? path.join(cwd, CONFIG_DIR_NAME, "generated-images")
                : save === "global"
                  ? path.join(agentDir, "generated-images")
                  : resolveCustomDirectory(customDirectory);
          if (save === "custom" && !saveDir)
            return yield* fail("save", "save=custom requires saveDir or PI_IMAGE_SAVE_DIR.");
          const credentials = yield* credentialsFor(ctx);
          if (!credentials)
            return yield* fail(
              "auth",
              "Missing openai-codex OAuth credentials. Run /login openai-codex.",
            );
          const inputs = yield* readInputs(params.images, cwd);
          const response = yield* http
            .requestJsonRawBytes(
              {
                url: CODEX_RESPONSES_URL,
                method: "POST",
                headers: {
                  authorization: `Bearer ${credentials.accessToken}`,
                  "chatgpt-account-id": credentials.accountId,
                  "OpenAI-Beta": "responses=experimental",
                  accept: "text/event-stream",
                  originator: "codex_cli_rs",
                  "User-Agent": "codex_cli_rs/0.0.0 (pi-better-openai)",
                },
              },
              ImageRequestSchema,
              buildRequest(params, model, cfg, inputs),
            )
            .pipe(
              Effect.mapError(imageError("request", "Codex image request failed.")),
              Effect.withSpan("pi-better-openai.image.request"),
            );
          if (response.status < 200 || response.status >= 300) {
            yield* response.discardRawBody.pipe(
              Effect.timeout("1 second"),
              Effect.catch(() => Effect.void),
            );
            return yield* fail("request", `Codex image request failed (${response.status}).`);
          }
          const parsed = yield* parseSse(
            response.rawBody,
            imageMimeType(`image.${outputFormat}`, outputFormat),
          ).pipe(Effect.withSpan("pi-better-openai.image.stream"));
          const validated = yield* validatedGeneratedImage(parsed, outputFormat).pipe(
            Effect.withSpan("pi-better-openai.image.convert"),
          );
          let savedPath: string | undefined;
          if (saveDir) {
            const protectedBase =
              save === "project" ? cwd : save === "global" ? agentDir : undefined;
            savedPath = yield* persistImage(
              saveDir,
              protectedBase,
              validated.bytes,
              outputFormat,
              validated.id,
            ).pipe(Effect.withSpan("pi-better-openai.image.write"));
          }
          const { bytes: _bytes, ...image } = validated;
          const result: CodexImageResult = {
            ...image,
            prompt: params.prompt,
            ...(savedPath ? { savedPath } : {}),
            model,
            action,
            outputFormat,
          };
          yield* Ref.set(state, { lastStatus: `completed (${result.id})` });
          return result;
        });
        const safeGenerate = (params: unknown) =>
          Effect.suspend(() =>
            generate(params).pipe(
              Effect.timeout(
                MutableRef.get(options.projection).config?.image.timeoutMs ?? DEFAULT_TIMEOUT_MS,
              ),
            ),
          ).pipe(
            Effect.mapError((error) => {
              const message = sanitizeDiagnosticError(
                "message" in error && typeof error.message === "string"
                  ? error.message
                  : "OpenAI image request timed out.",
              );
              return fail(
                "operation" in error && typeof error.operation === "string"
                  ? error.operation
                  : "timeout",
                message,
              );
            }),
            Effect.tapError((error) =>
              Ref.set(state, { lastStatus: "error", lastError: error.message }),
            ),
          );
        const debug = Effect.fn("OpenAIImage.debug")(function* () {
          const ctx = MutableRef.get(options.context);
          const cfg = MutableRef.get(options.projection).config;
          const credentials = yield* credentialsFor(ctx).pipe(Effect.catch(() => Effect.void));
          const image = cfg?.image;
          const accountId = maskIdentifier(credentials?.accountId);
          return {
            authFound: credentials !== undefined,
            ...(credentials ? { authSource: credentials.source } : {}),
            ...(accountId ? { accountId } : {}),
            endpoint: CODEX_RESPONSES_URL,
            defaultModel:
              ctx.model?.provider === "openai-codex"
                ? ctx.model.id
                : (image?.defaultModel ?? "gpt-5.5"),
            defaultSave: image?.defaultSave ?? "project",
            enabled: image?.enabled ?? false,
            ...(yield* Ref.get(state)),
          } satisfies ImageGenerationDebug;
        });
        return OpenAIImageService.of({ generate: safeGenerate, debug });
      }),
    );
  }
}
