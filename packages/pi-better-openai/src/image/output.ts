import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Scope from "effect/Scope";
import type { SharpAdapterContract } from "../boundary/sharp.ts";
import { decodeBase64, extensionForFormat, imageMimeType, isInside } from "./helpers.ts";
import { fail, type ExtractedImageResult, type ImageOutputFormat } from "./types.ts";

const imageVerificationLostMessage =
  "OpenAI image post-commit verification could not stat the destination; skipping identity check.";

export const makeImageOutput = (dependencies: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly sharp: SharpAdapterContract;
}) => {
  const { fs, path, sharp } = dependencies;
  const imageError = (operation: string, message: string) => () => fail(operation, message);
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
        .pipe(Effect.mapError(imageError("save", "Unable to resolve protected output root.")));
      if (!isInside(path, protectedBase, requestedDirectory))
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
      if (canonicalAncestor !== canonicalBase && !isInside(path, canonicalBase, canonicalAncestor))
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
    const verifyPublicationSource = Effect.fn("OpenAIImage.verifyPublicationSource")(function* () {
      if (!ownedIdentity)
        return yield* fail("save", "Unable to verify image temporary file identity.");
      const actualTemporary = yield* fs
        .realPath(temporary)
        .pipe(Effect.mapError(imageError("save", "Unable to verify image temporary path.")));
      const visible = yield* fs
        .stat(temporary)
        .pipe(Effect.mapError(imageError("save", "Unable to verify image temporary file.")));
      const visibleInode = Option.getOrUndefined(visible.ino);
      if (
        visible.type !== "File" ||
        visibleInode !== ownedIdentity.ino ||
        visible.dev !== ownedIdentity.dev ||
        !isInside(path, canonicalDirectory, actualTemporary) ||
        (canonicalBase && !isInside(path, canonicalBase, actualTemporary))
      )
        return yield* fail("save", "Image temporary file escaped its protected root.");
    });
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
          Effect.mapError(imageError("save", "Unable to verify image temporary file identity.")),
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
                        imageError("save", "Unable to publish generated image without clobbering."),
                      ),
                    );
                  linked = true;
                  if (ownedIdentity)
                    publishedIdentity = {
                      type: "File",
                      dev: ownedIdentity.dev,
                      ino: ownedIdentity.ino,
                    };
                  // The hard link above is the commit point. Post-commit verification is
                  // best-effort defense against a swapped destination: neither a typed
                  // verification failure nor a defect may undo the committed publication,
                  // so only a positive identity mismatch unlinks the published file.
                  const published = yield* fs.stat(destination).pipe(
                    Effect.option,
                    // A typed stat failure also loses verification evidence; say so even
                    // though the loss cannot undo the committed publication.
                    Effect.tap((published) =>
                      Option.isNone(published)
                        ? Effect.logWarning(imageVerificationLostMessage)
                        : Effect.void,
                    ),
                    // A defect during stat loses verification too; warn and continue.
                    Effect.catchCause(() =>
                      Effect.logWarning(imageVerificationLostMessage).pipe(
                        Effect.as(Option.none()),
                      ),
                    ),
                  );
                  if (Option.isNone(published)) return;
                  const publishedStat = published.value;
                  const publishedInode = Option.getOrUndefined(publishedStat.ino);
                  if (
                    !ownedIdentity ||
                    publishedStat.type !== "File" ||
                    publishedInode === undefined ||
                    publishedInode !== ownedIdentity.ino ||
                    publishedStat.dev !== ownedIdentity.dev
                  ) {
                    if (publishedInode !== undefined)
                      publishedIdentity = {
                        type: publishedStat.type,
                        dev: publishedStat.dev,
                        ino: publishedInode,
                      };
                    return yield* fail(
                      "save",
                      "Published image did not match the owned temporary file.",
                    );
                  }
                }).pipe(Effect.onError(() => (linked ? removePublishedDestination : Effect.void)));
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
  return { validatedGeneratedImage, persistImage } as const;
};
