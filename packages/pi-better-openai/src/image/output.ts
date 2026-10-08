import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Scope from "effect/Scope";
import { isStrictlyInsidePathWith } from "pi-cosmic-core";
import type { SharpAdapterContract } from "../boundary/sharp.ts";
import type { ImageOutputFormat } from "../config/schema.ts";
import { fail, failWith, type ExtractedImageResult } from "./types.ts";

const MAX_GENERATED_IMAGE_BYTES = 60 * 1024 * 1024;
const imageVerificationLostMessage =
  "OpenAI image post-commit verification could not stat the destination; skipping identity check.";

const outputFormats = {
  png: { extension: "png", mimeType: "image/png", sharpFormat: "png" },
  jpeg: { extension: "jpg", mimeType: "image/jpeg", sharpFormat: "jpeg" },
  webp: { extension: "webp", mimeType: "image/webp", sharpFormat: "webp" },
} as const satisfies Record<
  ImageOutputFormat,
  { readonly extension: string; readonly mimeType: string; readonly sharpFormat: string }
>;

export const imageOutputMetadata = (format: ImageOutputFormat) => outputFormats[format];

const decodeStrictBase64 = (value: string): Uint8Array | undefined => {
  if (
    value.length === 0 ||
    value.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.length <= MAX_GENERATED_IMAGE_BYTES ? bytes : undefined;
};

export const makeImageOutput = (dependencies: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly sharp: SharpAdapterContract;
}) => {
  const { fs, path, sharp } = dependencies;
  const isInside = (root: string, child: string) =>
    isStrictlyInsidePathWith(path, path.resolve(root), path.resolve(child));
  const validatedGeneratedImage = Effect.fn("OpenAIImage.validateGeneratedImage")(function* (
    parsed: ExtractedImageResult,
    outputFormat: ImageOutputFormat,
  ) {
    const bytes = decodeStrictBase64(parsed.data);
    if (!bytes) return yield* fail("response", "Codex returned invalid image base64.");
    const metadata = yield* sharp
      .decode(bytes)
      .pipe(Effect.mapError(failWith("response", "Codex returned unreadable image data.")));
    const expected = imageOutputMetadata(outputFormat);
    const actual = metadata.format === "jpg" ? "jpeg" : metadata.format;
    if (actual !== expected.sharpFormat)
      return yield* fail(
        "response",
        `Codex returned ${actual ?? "unknown"} image data when ${expected.sharpFormat} was requested.`,
      );
    return {
      ...parsed,
      data: Buffer.from(bytes).toString("base64"),
      mimeType: expected.mimeType,
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
        .pipe(Effect.mapError(failWith("save", "Unable to resolve protected output root.")));
      if (!isInside(protectedBase, requestedDirectory))
        return yield* fail("save", "Image output directory escapes its protected root.");
      // `exists` is false only for a missing path; other probe failures must stay typed.
      const exists = (candidate: string) =>
        fs
          .exists(candidate)
          .pipe(Effect.mapError(failWith("save", "Unable to inspect image output path.")));
      let existingAncestor = path.resolve(requestedDirectory);
      while (!(yield* exists(existingAncestor))) {
        const parent = path.dirname(existingAncestor);
        if (parent === existingAncestor)
          return yield* fail("save", "Unable to resolve image output directory.");
        existingAncestor = parent;
      }
      const canonicalAncestor = yield* fs
        .realPath(existingAncestor)
        .pipe(Effect.mapError(failWith("save", "Unable to inspect image output path.")));
      if (canonicalAncestor !== canonicalBase && !isInside(canonicalBase, canonicalAncestor))
        return yield* fail("save", "Image output directory escapes its protected root.");
    }
    yield* fs
      .makeDirectory(requestedDirectory, { recursive: true })
      .pipe(Effect.mapError(failWith("save", "Unable to create image output directory.")));
    const canonicalDirectory = yield* fs
      .realPath(requestedDirectory)
      .pipe(Effect.mapError(failWith("save", "Unable to resolve image output directory.")));
    if (
      canonicalBase &&
      canonicalDirectory !== canonicalBase &&
      !isInside(canonicalBase, canonicalDirectory)
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
    const format = imageOutputMetadata(outputFormat);
    const destination = path.join(
      canonicalDirectory,
      `openai-image-${stamp}-${safeId}-${nonce}.${format.extension}`,
    );
    const temporary = `${destination}.${nonce}.tmp`;
    let ownedIdentity: { readonly dev: number; readonly ino: number } | undefined;
    const isOwned = (info: FileSystem.File.Info) =>
      ownedIdentity !== undefined &&
      info.type === "File" &&
      Option.getOrUndefined(info.ino) === ownedIdentity.ino &&
      info.dev === ownedIdentity.dev;
    const removeOwnedTemporary = Effect.gen(function* () {
      if (!ownedIdentity) return;
      if (isOwned(yield* fs.stat(temporary))) yield* fs.remove(temporary);
    }).pipe(Effect.ignoreCause);
    const verifyPublicationSource = Effect.fn("OpenAIImage.verifyPublicationSource")(function* () {
      if (!ownedIdentity)
        return yield* fail("save", "Unable to verify image temporary file identity.");
      const actualTemporary = yield* fs
        .realPath(temporary)
        .pipe(Effect.mapError(failWith("save", "Unable to verify image temporary path.")));
      const visible = yield* fs
        .stat(temporary)
        .pipe(Effect.mapError(failWith("save", "Unable to verify image temporary file.")));
      if (
        !isOwned(visible) ||
        !isInside(canonicalDirectory, actualTemporary) ||
        (canonicalBase && !isInside(canonicalBase, actualTemporary))
      )
        return yield* fail("save", "Image temporary file escaped its protected root.");
    });
    const acquireTemporary = Effect.scoped(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const parentScope = yield* Effect.scope;
          const fileScope = yield* Scope.fork(parentScope);
          const writeExit = yield* restore(
            Effect.gen(function* () {
              const file = yield* fs
                .open(temporary, { flag: "wx" })
                .pipe(Effect.mapError(failWith("save", "Unable to create image temporary file.")));
              const opened = yield* file.stat.pipe(
                Effect.mapError(
                  failWith("save", "Unable to verify image temporary file identity."),
                ),
              );
              const openedInode = Option.getOrUndefined(opened.ino);
              if (opened.type !== "File" || openedInode === undefined)
                return yield* fail("save", "Unable to verify image temporary file identity.");
              ownedIdentity = { dev: opened.dev, ino: openedInode };
              yield* verifyPublicationSource();
              yield* file
                .writeAll(bytes)
                .pipe(Effect.mapError(failWith("save", "Unable to save generated image.")));
              yield* file.sync.pipe(
                Effect.mapError(failWith("save", "Unable to sync generated image.")),
              );
            }).pipe(Scope.provide(fileScope)),
          ).pipe(Effect.exit);
          const closeExit = yield* Scope.close(fileScope, writeExit).pipe(Effect.exit);
          if (Exit.isFailure(writeExit)) return yield* Effect.failCause(writeExit.cause);
          if (Exit.isFailure(closeExit))
            return yield* fail("save", "Unable to close image temporary file.");
        }),
      ),
    ).pipe(Effect.onError(() => removeOwnedTemporary));
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.acquireUseRelease(
        restore(acquireTemporary),
        () =>
          Effect.gen(function* () {
            yield* verifyPublicationSource();
            yield* fs
              .link(temporary, destination)
              .pipe(
                Effect.mapError(
                  failWith("save", "Unable to publish generated image without clobbering."),
                ),
              );
            // Linking is the commit point. Never remove the destination after this succeeds:
            // another process may replace it before verification observes the path.
            const published = yield* fs
              .stat(destination)
              .pipe(
                Effect.catchCause(() =>
                  Effect.logWarning(imageVerificationLostMessage).pipe(Effect.as(undefined)),
                ),
              );
            if (published && !isOwned(published))
              return yield* fail("save", "Published image did not match the owned temporary file.");
          }).pipe(Effect.uninterruptible),
        () => removeOwnedTemporary,
      ).pipe(Effect.as(destination)),
    );
  });
  return { validatedGeneratedImage, persistImage } as const;
};
