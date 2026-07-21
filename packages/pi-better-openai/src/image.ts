import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Image, Text } from "@earendil-works/pi-tui";
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
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  AgentDirectory,
  JsonDocumentStore,
  SafeFile,
  StreamingHttpClient,
  type StreamingHttpError,
} from "pi-cosmic-core";
import { safeHostSignal, safeHostUi } from "./boundary/host-ui.ts";
import { SharpAdapter } from "./boundary/sharp.ts";
import type { ResolvedConfig } from "./config.ts";
import { extractAccountIdFromJwt, getCodexCredentials } from "./codex-auth.ts";
import { maskIdentifier, sanitizeDiagnosticError } from "./format.ts";
import { decodeImageStreamEvent, ImageRequestSchema, type ImageRequest } from "./image-protocol.ts";
import type { OpenAIProjection } from "./usage-controller.ts";
import { isRecord } from "./utils.ts";

const OPENAI_IMAGE_TOOL = "openai_image";
const OPENAI_IMAGE_COMMAND = "openai-image";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_INPUTS = 5;
const MAX_TOTAL_IMAGE_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_RESPONSE_BYTES = 100 * 1024 * 1024;
const MAX_SSE_EVENT_CHARS = 80 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES = 60 * 1024 * 1024;
const SUPPORTED_INPUT_IMAGE_FORMATS = new Set(["png", "jpeg", "jpg", "webp", "gif"]);
export const IMAGE_SAVE_MODES = ["none", "project", "global", "custom"] as const;
export const IMAGE_ACTIONS = ["auto", "generate", "edit"] as const;
export const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
export type ImageSaveMode = (typeof IMAGE_SAVE_MODES)[number];
export type ImageAction = (typeof IMAGE_ACTIONS)[number];
export type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];

const NON_WHITESPACE_PATTERN = "\\S";
const PROMPT_MAX_LENGTH = 32_768;
const PATH_MAX_LENGTH = 4_096;
const MODEL_MAX_LENGTH = 256;
const boundedJsonString = (maximum: number) => ({
  type: "string" as const,
  minLength: 1,
  maxLength: maximum,
  pattern: NON_WHITESPACE_PATTERN,
});
const TOOL_PARAMS = {
  type: "object",
  properties: {
    prompt: {
      ...boundedJsonString(PROMPT_MAX_LENGTH),
      description:
        "Image generation/editing prompt. Pass the user's wording verbatim unless they explicitly ask you to refine or expand it.",
    },
    action: { type: "string", enum: IMAGE_ACTIONS },
    images: {
      type: "array",
      maxItems: MAX_IMAGE_INPUTS,
      items: boundedJsonString(PATH_MAX_LENGTH),
    },
    model: boundedJsonString(MODEL_MAX_LENGTH),
    outputFormat: { type: "string", enum: IMAGE_OUTPUT_FORMATS },
    save: { type: "string", enum: IMAGE_SAVE_MODES },
    saveDir: boundedJsonString(PATH_MAX_LENGTH),
  },
  required: ["prompt"],
  additionalProperties: false,
} as const;
const boundedString = (maximum: number) =>
  Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maximum), Schema.isPattern(/\S/));
const ToolParamsSchema = Schema.Struct({
  prompt: boundedString(PROMPT_MAX_LENGTH),
  action: Schema.optional(Schema.Literals(IMAGE_ACTIONS)),
  images: Schema.optional(
    Schema.Array(boundedString(PATH_MAX_LENGTH)).check(Schema.isMaxLength(MAX_IMAGE_INPUTS)),
  ),
  model: Schema.optional(boundedString(MODEL_MAX_LENGTH)),
  outputFormat: Schema.optional(Schema.Literals(IMAGE_OUTPUT_FORMATS)),
  save: Schema.optional(Schema.Literals(IMAGE_SAVE_MODES)),
  saveDir: Schema.optional(boundedString(PATH_MAX_LENGTH)),
});
const TOOL_PARAM_KEYS = new Set(Object.keys(TOOL_PARAMS.properties));
type ToolParams = typeof ToolParamsSchema.Type;
type ImageInput = { readonly path: string; readonly data: string; readonly mimeType: string };
export type CodexImageResult = {
  id: string;
  status: string;
  prompt: string;
  revisedPrompt?: string;
  data: string;
  mimeType: string;
  savedPath?: string;
  model: string;
  action: ImageAction;
  outputFormat: ImageOutputFormat;
};
type ExtractedImageResult = Omit<
  CodexImageResult,
  "prompt" | "savedPath" | "model" | "action" | "outputFormat"
>;
export type ImageGenerationDebug = {
  authFound: boolean;
  authSource?: string;
  accountId?: string;
  endpoint: string;
  defaultModel: string;
  defaultSave: ImageSaveMode;
  enabled: boolean;
  lastStatus?: string;
  lastError?: string;
};
interface ImageState {
  readonly lastStatus?: string;
  readonly lastError?: string;
}

export class OpenAIImageError extends Schema.TaggedErrorClass<OpenAIImageError>()(
  "OpenAIImageError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}
const fail = (operation: string, message: string) => new OpenAIImageError({ operation, message });

function resolveModel(
  params: Pick<ToolParams, "model">,
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
): string {
  const model = params.model?.trim();
  if (model) return model.includes("/") ? model.split("/").pop() || model : model;
  return ctx.model?.provider === "openai-codex"
    ? (ctx.model.id ?? cfg.image.defaultModel)
    : cfg.image.defaultModel;
}
function resolveImageConfig(cfg: ResolvedConfig, params: ToolParams) {
  return {
    action: params.action ?? "auto",
    outputFormat: params.outputFormat ?? cfg.image.outputFormat,
    save: params.save ?? cfg.image.defaultSave,
  };
}
function imageMimeType(path: string, outputFormat?: string): string {
  if (outputFormat === "jpeg" || outputFormat === "jpg") return "image/jpeg";
  if (outputFormat === "webp") return "image/webp";
  if (outputFormat === "gif") return "image/gif";
  if (outputFormat === "png") return "image/png";
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/png";
}
const extensionForFormat = (format: ImageOutputFormat) => (format === "jpeg" ? "jpg" : format);
const isInside = (path: Path.Path, root: string, child: string) => {
  const normalizedRoot = path.resolve(root);
  const normalizedChild = path.resolve(child);
  return (
    normalizedChild !== normalizedRoot && normalizedChild.startsWith(`${normalizedRoot}${path.sep}`)
  );
};
function dataUrlParts(value: string, expectedMimeType: string): { data: string; mimeType: string } {
  const match = /^data:[^;,]+;base64,(.*)$/s.exec(value);
  return { data: (match?.[1] ?? value).trim(), mimeType: expectedMimeType };
}
function decodeBase64(value: string): Uint8Array | undefined {
  if (
    value.length === 0 ||
    value.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.length <= MAX_GENERATED_IMAGE_BYTES ? bytes : undefined;
}
function asImageResultItem(
  value: unknown,
):
  | { id?: string; status?: string; revised_prompt?: string; result?: string; b64_json?: string }
  | undefined {
  if (!isRecord(value) || value.type !== "image_generation_call") return undefined;
  return value;
}
function extractImageFromEvent(
  event: unknown,
  fallbackMimeType: string,
  fallbackId: string,
): ExtractedImageResult | undefined {
  if (!isRecord(event)) return undefined;
  const item = asImageResultItem(event.item) ?? asImageResultItem(event);
  if (item) {
    const raw =
      typeof item.result === "string" && item.result.trim()
        ? item.result
        : typeof item.b64_json === "string"
          ? item.b64_json
          : undefined;
    if (!raw) return undefined;
    const parts = dataUrlParts(raw, fallbackMimeType);
    return {
      id: typeof item.id === "string" ? item.id : fallbackId,
      status: typeof item.status === "string" ? item.status : "completed",
      ...(typeof item.revised_prompt === "string" ? { revisedPrompt: item.revised_prompt } : {}),
      ...parts,
    };
  }
  const partial =
    typeof event.partial_image_b64 === "string"
      ? event.partial_image_b64
      : typeof event.b64_json === "string"
        ? event.b64_json
        : undefined;
  if (partial?.trim())
    return { id: fallbackId, status: "partial", ...dataUrlParts(partial, fallbackMimeType) };
  return undefined;
}
function buildRequest(
  params: ToolParams,
  model: string,
  cfg: ResolvedConfig,
  images: readonly ImageInput[],
): ImageRequest {
  const { action, outputFormat } = resolveImageConfig(cfg, params);
  const content: Array<
    | { readonly type: "input_text"; readonly text: string }
    | {
        readonly type: "input_image";
        readonly detail: "auto";
        readonly image_url: string;
      }
  > = [{ type: "input_text", text: params.prompt }];
  for (const image of images)
    content.push({
      type: "input_image",
      detail: "auto",
      image_url: `data:${image.mimeType};base64,${image.data}`,
    });
  const tool: ImageRequest["tools"][number] =
    action === "auto"
      ? { type: "image_generation", output_format: outputFormat }
      : { type: "image_generation", output_format: outputFormat, action };
  return {
    model,
    instructions: "",
    input: [{ role: "user", content }],
    tools: [tool],
    tool_choice: { type: "image_generation" },
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: [],
    client_metadata: { "x-codex-installation-id": "pi-better-openai" },
  } satisfies ImageRequest;
}

export interface OpenAIImageServiceShape {
  readonly generate: (params: unknown) => Effect.Effect<CodexImageResult, OpenAIImageError>;
  readonly debug: () => Effect.Effect<ImageGenerationDebug>;
}
export class OpenAIImageService extends Context.Service<
  OpenAIImageService,
  OpenAIImageServiceShape
>()("pi-better-openai/image/OpenAIImageService") {
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
            if (isRecord(event) && event.type === "response.failed") {
              const response = isRecord(event.response) ? event.response : undefined;
              const error = isRecord(response?.error) ? response.error : undefined;
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
            if (isRecord(event) && event.type === "error") {
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
            try: () => (isRecord(rawParams) ? Object.keys(rawParams) : undefined),
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

function resultText(result: CodexImageResult): string {
  const parts = [
    `Generated image using OpenAI image_generation tool via openai-codex/${result.model}.`,
    `Action: ${result.action}.`,
    `Prompt: ${result.prompt}`,
  ];
  if (result.revisedPrompt) parts.push(`Revised prompt: ${result.revisedPrompt}`);
  if (result.savedPath) parts.push(`Saved: ${result.savedPath}`);
  return parts.join("\n");
}
const isImageContent = (
  value: unknown,
): value is { type: "image"; data: string; mimeType: string } =>
  isRecord(value) &&
  value.type === "image" &&
  typeof value.data === "string" &&
  typeof value.mimeType === "string";

export function registerOpenAIImage(
  pi: ExtensionAPI,
  run: <A, E>(effect: Effect.Effect<A, E, OpenAIImageService>, signal?: AbortSignal) => Promise<A>,
  updateContext: (ctx: ExtensionContext) => void,
) {
  const generate = (params: unknown, ctx: ExtensionContext, signal?: AbortSignal) => {
    updateContext(ctx);
    return run(
      OpenAIImageService.use((service) => service.generate(params)),
      signal,
    );
  };
  const getDebug = (ctx: ExtensionContext) => {
    updateContext(ctx);
    return run(
      OpenAIImageService.use((service) => service.debug()),
      safeHostSignal(ctx),
    );
  };
  pi.registerMessageRenderer<CodexImageResult>("openai-image", (message, _options, theme) => {
    const result = message.details;
    const text =
      result && isRecord(result)
        ? resultText(result as CodexImageResult)
        : typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
    let image: { data: string; mimeType: string; savedPath?: string } | undefined;
    if (
      result &&
      isRecord(result) &&
      typeof result.data === "string" &&
      typeof result.mimeType === "string"
    )
      image = {
        data: result.data,
        mimeType: result.mimeType,
        ...(typeof result.savedPath === "string" ? { savedPath: result.savedPath } : {}),
      };
    else if (Array.isArray(message.content)) {
      const part = message.content.find(isImageContent);
      if (part) image = part;
    }
    const container = new Container();
    const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
    box.addChild(new Text(`${theme.fg("accent", theme.bold("[openai-image]"))}\n\n${text}`, 0, 0));
    if (image)
      box.addChild(
        new Image(
          image.data,
          image.mimeType,
          { fallbackColor: (line) => theme.fg("dim", line) },
          {
            maxWidthCells: 80,
            maxHeightCells: 24,
            ...(image.savedPath ? { filename: image.savedPath } : {}),
          },
        ),
      );
    container.addChild(box);
    return container;
  });
  pi.registerCommand(OPENAI_IMAGE_COMMAND, {
    description: "Generate an image with OpenAI Codex image generation",
    handler: (args, ctx) => {
      const prompt = args.trim();
      if (!prompt) {
        safeHostUi(() => ctx.ui.notify("Usage: /openai-image <prompt>", "error"));
        return Promise.resolve();
      }
      safeHostUi(() => ctx.ui.notify("Requesting OpenAI image...", "info"));
      return generate({ prompt }, ctx, safeHostSignal(ctx)).then((result) =>
        pi.sendMessage({
          customType: "openai-image",
          content: [
            { type: "text", text: resultText(result) },
            { type: "image", data: result.data, mimeType: result.mimeType },
          ],
          display: true,
          details: result,
        }),
      );
    },
  });
  pi.registerTool({
    name: OPENAI_IMAGE_TOOL,
    label: "OpenAI image",
    description:
      "Generate or edit images through OpenAI Codex subscription auth using the hosted image_generation tool.",
    promptSnippet: "Generate or edit raster images via OpenAI Codex subscription auth.",
    promptGuidelines: [
      "Use openai_image when the user asks to generate or edit a raster image.",
      "Pass the user's image prompt verbatim. Do not embellish or rewrite it unless explicitly requested.",
    ],
    parameters: TOOL_PARAMS,
    execute(_id, params, signal, onUpdate, ctx) {
      const projectionText = `Requesting OpenAI image_generation via ${ctx.model?.id ?? "configured model"}...`;
      onUpdate?.({ content: [{ type: "text", text: projectionText }], details: undefined });
      return generate(params, ctx, signal).then((result) => ({
        content: [
          { type: "text", text: resultText(result) },
          { type: "image" as const, data: result.data, mimeType: result.mimeType },
        ],
        details: result,
      }));
    },
  });
  return { getDebug };
}

export const _imageTest = {
  TOOL_PARAMS,
  CODEX_RESPONSES_URL,
  DEFAULT_TIMEOUT_MS,
  OPENAI_IMAGE_TOOL,
  OPENAI_IMAGE_COMMAND,
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_INPUTS,
  MAX_TOTAL_IMAGE_INPUT_BYTES,
  extractAccountIdFromJwt,
  imageMimeType,
  dataUrlParts,
  extractImageFromEvent,
  buildRequest,
};
