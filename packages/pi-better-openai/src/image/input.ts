import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { SafeFileContract } from "pi-cosmic-core";
import type { SharpAdapterContract } from "../boundary/sharp.ts";
import { imageMimeType, isInside } from "./helpers.ts";
import {
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_INPUTS,
  MAX_TOTAL_IMAGE_INPUT_BYTES,
  SUPPORTED_INPUT_IMAGE_FORMATS,
  fail,
} from "./types.ts";

export const makeImageInputReader = (dependencies: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly safeFile: SafeFileContract;
  readonly sharp: SharpAdapterContract;
}) => {
  const { fs, path, safeFile, sharp } = dependencies;
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
        Effect.mapError(imageError("sharp", `Image input is not a readable image: ${inputPath}`)),
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

  return Effect.fn("OpenAIImage.readInputs")(function* (
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
};
