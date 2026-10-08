import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import { isStrictlyInsidePathWith, type SafeFileContract } from "pi-cosmic-core";
import type { SharpAdapterContract } from "../boundary/sharp.ts";
import { MAX_IMAGE_INPUTS, fail, failWith, type ImageInput } from "./types.ts";

const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_IMAGE_INPUT_BYTES = 50 * 1024 * 1024;
// A Map, so a decoded format can never match an inherited object key.
const INPUT_MIME_TYPES: ReadonlyMap<string, string> = new Map([
  ["png", "image/png"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
]);
const outsideWorkspace = (path: string) =>
  fail("input", `Image input must be a file inside the current workspace: ${path}`);

export const makeImageInputReader = (dependencies: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly safeFile: SafeFileContract;
  readonly sharp: SharpAdapterContract;
}) => {
  const { fs, path, safeFile, sharp } = dependencies;
  const isInside = (root: string, child: string) =>
    isStrictlyInsidePathWith(path, path.resolve(root), path.resolve(child));
  const validateInput = Effect.fn("OpenAIImage.validateInput")(function* (
    inputPath: string,
    realWorkspace: string,
  ) {
    const realInput = yield* fs
      .realPath(inputPath)
      .pipe(Effect.mapError(() => outsideWorkspace(inputPath)));
    if (!isInside(realWorkspace, realInput)) return yield* outsideWorkspace(inputPath);
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
        Effect.mapError(failWith("sharp", `Image input is not a readable image: ${inputPath}`)),
      );
    const mimeType = metadata.format && INPUT_MIME_TYPES.get(metadata.format);
    if (!mimeType) return yield* fail("input", `Image input is not a readable image: ${inputPath}`);
    return { path: verified.path, data: verified.bytes, mimeType };
  });

  return Effect.fn("OpenAIImage.readInputs")(function* (
    rawPaths: readonly string[] | undefined,
    cwd: string,
  ) {
    const workspace = path.resolve(cwd);
    const realWorkspace = yield* fs.realPath(workspace).pipe(Effect.orElseSucceed(() => workspace));
    const seen = new Set<string>();
    const validated: ImageInput[] = [];
    let total = 0;
    for (const raw of rawPaths ?? []) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const candidate = path.resolve(workspace, trimmed);
      if (!isInside(workspace, candidate)) return yield* outsideWorkspace(candidate);
      const input = yield* validateInput(candidate, realWorkspace);
      if (seen.has(input.path)) continue;
      if (validated.length >= MAX_IMAGE_INPUTS)
        return yield* fail("input", `Too many image inputs (max ${MAX_IMAGE_INPUTS}).`);
      total += input.data.byteLength;
      if (total > MAX_TOTAL_IMAGE_INPUT_BYTES)
        return yield* fail("input", "Image inputs are too large in total (max 50 MB).");
      seen.add(input.path);
      validated.push({
        mimeType: input.mimeType,
        data: Buffer.from(input.data).toString("base64"),
      });
    }
    return validated;
  });
};
