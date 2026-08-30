import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { AgentDirectory, JsonDocumentStore, SafeFile, StreamingHttpClient } from "pi-cosmic-core";
import { getCodexCredentials } from "../auth/codex-auth.ts";
import { SharpAdapter } from "../boundary/sharp.ts";
import { DEFAULT_IMAGE_CONFIG, type ResolvedConfig } from "../config/schema.ts";
import type { OpenAIProjection } from "../usage/projection.ts";
import { makeImageInputReader } from "./input.ts";
import { imageOutputMetadata, makeImageOutput } from "./output.ts";
import { buildImageRequest, ImageRequestSchema } from "./protocol.ts";
import { parseImageSse } from "./stream.ts";
import {
  TOOL_PARAMS,
  ToolParamsSchema,
  fail,
  type CodexImageResult,
  type ImageAction,
  type ImageOutputFormat,
  type ImageSaveMode,
  type ToolParams,
} from "./types.ts";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const TOOL_PARAM_KEYS = new Set(Object.keys(TOOL_PARAMS.properties));

const resolveModel = (
  params: Pick<ToolParams, "model">,
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
): string => {
  const requested = params.model?.trim();
  if (requested)
    return requested.includes("/") ? requested.split("/").pop() || requested : requested;
  const currentModel = ctx.model;
  return currentModel?.provider === "openai-codex"
    ? (currentModel.id ?? cfg.image.defaultModel)
    : cfg.image.defaultModel;
};

interface OpenAIImageServiceOptions {
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly projection: MutableRef.MutableRef<OpenAIProjection>;
  readonly agentDir?: string;
}

export class OpenAIImageService extends Context.Service<OpenAIImageService>()(
  "pi-better-openai/image/service/OpenAIImageService",
  {
    make: (options: OpenAIImageServiceOptions) =>
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
        const credentialsFor = (ctx: Pick<ExtensionContext, "modelRegistry">) =>
          getCodexCredentials(authPath, ctx).pipe(
            Effect.provideService(JsonDocumentStore, documents),
          );

        const imageError = (operation: string, message: string) => () => fail(operation, message);
        const readInputs = makeImageInputReader({ fs, path, safeFile, sharp });
        const { validatedGeneratedImage, persistImage } = makeImageOutput({ fs, path, sharp });
        const generate = Effect.fn("OpenAIImage.generate")(function* <RawParams>(
          rawParams: RawParams,
          ctx: ExtensionContext,
          cfg: ResolvedConfig | undefined,
        ) {
          const parameterKeys = yield* Effect.try({
            try: () => (Predicate.isObject(rawParams) ? Object.keys(rawParams) : undefined),
            catch: imageError("params", "Invalid OpenAI image parameters."),
          });
          if (!parameterKeys || parameterKeys.some((key) => !TOOL_PARAM_KEYS.has(key)))
            return yield* fail("params", "Invalid OpenAI image parameters.");
          const params = yield* Schema.decodeUnknownEffect(ToolParamsSchema)(rawParams).pipe(
            Effect.mapError(imageError("params", "Invalid OpenAI image parameters.")),
          );
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
          const action: ImageAction = params.action ?? "auto";
          const outputFormat: ImageOutputFormat = params.outputFormat ?? cfg.image.outputFormat;
          const save: ImageSaveMode = params.save ?? cfg.image.defaultSave;
          const output = imageOutputMetadata(outputFormat);
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
                  authorization: `Bearer ${Redacted.value(credentials.accessToken)}`,
                  "chatgpt-account-id": credentials.accountId,
                  "OpenAI-Beta": "responses=experimental",
                  accept: "text/event-stream",
                  originator: "codex_cli_rs",
                  "User-Agent": "codex_cli_rs/0.0.0 (pi-better-openai)",
                },
              },
              ImageRequestSchema,
              buildImageRequest({
                prompt: params.prompt,
                model,
                action,
                outputFormat,
                images: inputs,
              }),
            )
            .pipe(
              Effect.mapError(imageError("request", "Codex image request failed.")),
              Effect.withSpan("pi-better-openai.image.request"),
            );
          if (response.status < 200 || response.status >= 300) {
            yield* response.discardRawBody.pipe(Effect.timeout("1 second"), Effect.ignore);
            return yield* fail("request", `Codex image request failed (${response.status}).`);
          }
          const parsed = yield* parseImageSse(response.rawBody, output.mimeType).pipe(
            Effect.withSpan("pi-better-openai.image.stream"),
          );
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
          const result: CodexImageResult = savedPath
            ? { ...image, prompt: params.prompt, savedPath, model, action, outputFormat }
            : { ...image, prompt: params.prompt, model, action, outputFormat };
          return result;
        });
        const safeGenerate = <Params>(params: Params) =>
          Effect.suspend(() => {
            const ctx = MutableRef.get(options.context);
            const cfg = MutableRef.get(options.projection).config;
            const timeoutMs = cfg?.image.timeoutMs ?? DEFAULT_IMAGE_CONFIG.timeoutMs;
            return generate(params, ctx, cfg).pipe(
              Effect.timeoutOrElse({
                duration: timeoutMs,
                orElse: () => Effect.fail(fail("timeout", "OpenAI image request timed out.")),
              }),
            );
          });
        return { generate: safeGenerate };
      }),
  },
) {
  static layer(options: OpenAIImageServiceOptions) {
    return Layer.effect(this, this.make(options));
  }
}
