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
import { AgentDirectory, SafeFile, StreamingHttpClient } from "pi-cosmic-core";
import { getCodexCredentials } from "../auth/codex-auth.ts";
import { SharpAdapter } from "../boundary/sharp.ts";
import { DEFAULT_IMAGE_CONFIG, type ImageSaveMode, type ResolvedConfig } from "../config/schema.ts";
import { imageInputReader } from "./input.ts";
import { imageOutputMetadata, imageOutput } from "./output.ts";
import { buildImageRequest, ImageRequestSchema } from "./protocol.ts";
import { httpFailure, parseImageSse } from "./stream.ts";
import {
  DEFAULT_IMAGE_MODEL,
  fail,
  failWith,
  prepareImageArguments,
  type CodexImageResult,
  type ToolParams,
} from "./types.ts";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

const resolveModel = (
  params: Pick<ToolParams, "model">,
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
): string => {
  const requested = params.model?.trim();
  if (requested) {
    const unqualified = requested.split("/").at(-1) ?? "";
    return unqualified.length > 0 ? unqualified : requested;
  }
  const currentModel = ctx.model;
  return currentModel?.provider === "openai-codex"
    ? (currentModel.id ?? cfg.image.defaultModel)
    : cfg.image.defaultModel;
};

interface SaveLocations {
  readonly cwd: string;
  readonly agentDir: string;
  readonly custom: string | undefined;
  readonly home: string | undefined;
}

interface SaveTarget {
  readonly directory: string;
  readonly root: string | undefined;
}

const resolveCustomDirectory = (path: Path.Path, { cwd, custom, home }: SaveLocations) => {
  if (!custom) return undefined;
  if (custom === "~") return home;
  if (custom.startsWith("~/")) return home ? path.resolve(home, custom.slice(2)) : undefined;
  return path.resolve(cwd, custom);
};

const resolveSaveTarget = (
  path: Path.Path,
  save: ImageSaveMode,
  locations: SaveLocations,
): SaveTarget | undefined => {
  if (save === "none") return undefined;
  if (save === "project")
    return {
      directory: path.join(locations.cwd, CONFIG_DIR_NAME, "generated-images"),
      root: locations.cwd,
    };
  if (save === "global")
    return {
      directory: path.join(locations.agentDir, "generated-images"),
      root: locations.agentDir,
    };
  const directory = resolveCustomDirectory(path, locations);
  return directory === undefined ? undefined : { directory, root: undefined };
};

// Direct callers get the tool's own argument preparation: blanks are absent and errors name the field.
const prepareToolParams = (params: ToolParams) =>
  Effect.try({
    try: () => prepareImageArguments(params),
    catch: (error) =>
      fail("params", Predicate.isError(error) ? error.message : "Invalid OpenAI image parameters."),
  });

const requestOptions = (params: ToolParams, cfg: ResolvedConfig) => ({
  imageModel: params.imageModel ?? DEFAULT_IMAGE_MODEL,
  action: params.action ?? "auto",
  outputFormat: params.outputFormat ?? cfg.image.outputFormat,
  save: params.save ?? cfg.image.defaultSave,
});

const customDirectory = (params: ToolParams, configured: Option.Option<string>) => {
  const requested = params.saveDir?.trim();
  return requested !== undefined && requested.length > 0
    ? requested
    : Option.getOrUndefined(configured)?.trim();
};

interface OpenAIImageServiceOptions {
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly config: () => ResolvedConfig | undefined;
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
        const agentDir = yield* AgentDirectory;
        const customSaveDir = yield* Config.option(Config.String("PI_IMAGE_SAVE_DIR"));
        const homeDirectory = yield* Config.option(Config.String("HOME"));

        const readInputs = imageInputReader({ fs, path, safeFile, sharp });
        const { validatedGeneratedImage, persistImage } = imageOutput({ fs, path, sharp });
        const generate = Effect.fn("OpenAIImage.generate")(function* (
          rawParams: ToolParams,
          ctx: ExtensionContext,
          cfg: ResolvedConfig | undefined,
        ) {
          const params = yield* prepareToolParams(rawParams);
          if (!cfg) return yield* fail("config", "Better OpenAI session has not started.");
          if (!cfg.image.enabled)
            return yield* fail("config", "OpenAI image generation is disabled in config.");
          const cwd = yield* Effect.try({
            try: () => ctx.cwd,
            catch: failWith("context", "Unable to read the Pi working directory."),
          });
          const model = yield* Effect.try({
            try: () => resolveModel(params, ctx, cfg),
            catch: failWith("context", "Unable to read the Pi model context."),
          });
          const { imageModel, action, outputFormat, save } = requestOptions(params, cfg);
          const output = imageOutputMetadata(outputFormat);
          const saveTarget = resolveSaveTarget(path, save, {
            cwd,
            agentDir,
            custom: customDirectory(params, customSaveDir),
            home: Option.getOrUndefined(homeDirectory),
          });
          if (save === "custom" && !saveTarget)
            return yield* fail("save", "save=custom requires saveDir or PI_IMAGE_SAVE_DIR.");
          const credentials = yield* getCodexCredentials(ctx);
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
                imageModel,
                action,
                outputFormat,
                images: inputs,
              }),
            )
            .pipe(
              Effect.mapError(failWith("request", "Codex image request failed.")),
              Effect.withSpan("pi-better-openai.image.request"),
            );
          if (response.status < 200 || response.status >= 300)
            return yield* httpFailure(response.status, response.rawBody);
          const parsed = yield* parseImageSse(response.rawBody, output.mimeType).pipe(
            Effect.withSpan("pi-better-openai.image.stream"),
          );
          const validated = yield* validatedGeneratedImage(parsed, outputFormat).pipe(
            Effect.withSpan("pi-better-openai.image.convert"),
          );
          const savedPath = saveTarget
            ? yield* persistImage(
                saveTarget.directory,
                saveTarget.root,
                validated.bytes,
                validated.outputFormat,
                validated.id,
              ).pipe(Effect.withSpan("pi-better-openai.image.write"))
            : undefined;
          const { bytes: _bytes, ...image } = validated;
          const result: CodexImageResult = {
            ...image,
            prompt: params.prompt,
            ...(savedPath !== undefined && { savedPath }),
            model,
            imageModel,
            action,
          };
          return result;
        });
        const safeGenerate = (params: ToolParams) =>
          Effect.suspend(() => {
            const ctx = MutableRef.get(options.context);
            const cfg = options.config();
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
