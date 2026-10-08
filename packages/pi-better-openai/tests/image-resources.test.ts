import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import { nodePlatformLayer, provideBuiltLayer } from "pi-cosmic-core";
import { makeCapturedLogger } from "pi-cosmic-core/testing";
import { makeImageOutput } from "../src/image/output.ts";
import { bytes, pngSharp } from "./helpers.ts";

const tempImages = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "pi-openai-image-test-" });
  return { fs, path, root, directory: path.join(root, "images") };
});

describe("OpenAI image resources", () => {
  it.effect("publishes atomically and preserves an existing destination on collision", () =>
    Effect.gen(function* () {
      const { fs, path, root, directory } = yield* tempImages;
      const output = makeImageOutput({ fs, path, sharp: pngSharp });
      const content = bytes("owned-image-bytes");
      const persist = output
        .persistImage(directory, root, content, "png", "provider/id")
        .pipe(Random.withSeed("collision-seed"));

      const destination = yield* persist;
      expect(yield* fs.exists(destination)).toBe(true);
      expect(Array.from(yield* fs.readFile(destination))).toEqual(Array.from(content));
      expect((yield* fs.readDirectory(directory)).filter((name) => name.endsWith(".tmp"))).toEqual(
        [],
      );

      const collision = yield* output
        .persistImage(directory, root, bytes("replacement"), "png", "provider/id")
        .pipe(Random.withSeed("collision-seed"), Effect.flip);
      expect(collision).toMatchObject({ _tag: "OpenAIImageError", operation: "save" });
      expect(Array.from(yield* fs.readFile(destination))).toEqual(Array.from(content));
      const visible = yield* fs.readDirectory(directory);
      expect(visible).toHaveLength(1);
      expect(visible.some((name) => name.endsWith(".tmp"))).toBe(false);
    }).pipe(provideBuiltLayer(nodePlatformLayer)),
  );

  it.effect("reports a failed output-path probe as a typed save failure", () =>
    Effect.gen(function* () {
      const { fs: realFs, path, root, directory } = yield* tempImages;
      // A platform failure other than a missing path, such as EACCES on an ancestor.
      const probeFailure = realFs.readFile(path.join(root, "missing")).pipe(Effect.as(false));
      const hostileFs: typeof realFs = Object.assign({}, realFs, { exists: () => probeFailure });
      const failure = yield* makeImageOutput({ fs: hostileFs, path, sharp: pngSharp })
        .persistImage(directory, root, bytes("owned-image-bytes"), "png", "provider/id")
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "OpenAIImageError", operation: "save" });
    }).pipe(provideBuiltLayer(nodePlatformLayer)),
  );

  it.effect("maps close defects without replacing typed write or sync failures", () =>
    Effect.gen(function* () {
      const { fs: realFs, path, root } = yield* tempImages;
      const failureCases = [
        { stage: "close", message: "Unable to close image temporary file." },
        { stage: "write", message: "Unable to save generated image." },
        { stage: "sync", message: "Unable to sync generated image." },
      ] as const;

      for (const failureCase of failureCases) {
        const directory = path.join(root, `images-${failureCase.stage}`);
        const missing = path.join(root, `missing-${failureCase.stage}`);
        let closeAttempts = 0;
        let linkCalls = 0;
        const hostileFs: typeof realFs = Object.assign({}, realFs, {
          open: (...args: Parameters<typeof realFs.open>) =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  closeAttempts++;
                }).pipe(Effect.andThen(Effect.die("temporary-close-defect"))),
              );
              const file = yield* realFs.open(...args);
              const failure = realFs.readFile(missing).pipe(Effect.asVoid);
              return {
                [FileSystem.FileTypeId]: file[FileSystem.FileTypeId],
                stat: file.stat,
                seek: file.seek,
                sync: failureCase.stage === "sync" ? failure : file.sync,
                read: file.read,
                readAlloc: file.readAlloc,
                truncate: file.truncate,
                write: file.write,
                writeAll:
                  failureCase.stage === "write"
                    ? () => failure
                    : (content) => file.writeAll(content),
              } satisfies FileSystem.File;
            }),
          link: (...args: Parameters<typeof realFs.link>) =>
            Effect.sync(() => {
              linkCalls++;
            }).pipe(Effect.andThen(realFs.link(...args))),
        });
        const output = makeImageOutput({ fs: hostileFs, path, sharp: pngSharp });

        const failure = yield* output
          .persistImage(directory, root, bytes("owned-image-bytes"), "png", "provider/id")
          .pipe(Effect.flip);

        expect(failure).toMatchObject({
          _tag: "OpenAIImageError",
          operation: "save",
          message: failureCase.message,
        });
        expect(closeAttempts).toBe(1);
        expect(linkCalls).toBe(0);
        expect(yield* realFs.readDirectory(directory)).toEqual([]);
      }
    }).pipe(provideBuiltLayer(nodePlatformLayer)),
  );

  it.effect("leaves a foreign replacement in place after a post-commit identity mismatch", () =>
    Effect.gen(function* () {
      const { fs: realFs, path, root, directory } = yield* tempImages;
      const foreignSource = path.join(root, "foreign-image.png");
      const foreignBytes = bytes("foreign-replacement-bytes");
      yield* realFs.writeFile(foreignSource, foreignBytes);
      let destination: string | undefined;
      const hostileFs: typeof realFs = Object.assign({}, realFs, {
        link: (source: string, target: string) =>
          Effect.gen(function* () {
            yield* realFs.link(source, target);
            yield* realFs.remove(target);
            yield* realFs.link(foreignSource, target);
            destination = target;
          }),
      });
      const output = makeImageOutput({ fs: hostileFs, path, sharp: pngSharp });

      const failure = yield* output
        .persistImage(directory, root, bytes("owned-image-bytes"), "png", "provider/id")
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "OpenAIImageError", operation: "save" });
      const publishedDestination = destination;
      if (!publishedDestination) return yield* Effect.die("destination was not published");
      expect(Array.from(yield* realFs.readFile(publishedDestination))).toEqual(
        Array.from(foreignBytes),
      );
      expect(
        (yield* realFs.readDirectory(directory)).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
    }).pipe(provideBuiltLayer(nodePlatformLayer)),
  );

  it.effect("removes its temporary file when image writing is interrupted", () =>
    Effect.gen(function* () {
      const { fs: realFs, path, root, directory } = yield* tempImages;
      const writeStarted = yield* Deferred.make<void>();
      const hostileFs: typeof realFs = Object.assign({}, realFs, {
        open: (...args: Parameters<typeof realFs.open>) =>
          realFs.open(...args).pipe(
            Effect.map(
              (file) =>
                ({
                  [FileSystem.FileTypeId]: file[FileSystem.FileTypeId],
                  stat: file.stat,
                  seek: file.seek,
                  sync: file.sync,
                  read: file.read,
                  readAlloc: file.readAlloc,
                  truncate: file.truncate,
                  write: file.write,
                  writeAll: (_content: Uint8Array) =>
                    Deferred.succeed(writeStarted, undefined).pipe(Effect.andThen(Effect.never)),
                }) satisfies FileSystem.File,
            ),
          ),
      });
      const output = makeImageOutput({ fs: hostileFs, path, sharp: pngSharp });
      const fiber = yield* output
        .persistImage(directory, root, bytes("owned-image-bytes"), "png", "provider/id")
        .pipe(Effect.forkScoped);

      yield* Deferred.await(writeStarted);
      yield* Fiber.interrupt(fiber);

      expect(yield* realFs.readDirectory(directory)).toEqual([]);
    }).pipe(provideBuiltLayer(nodePlatformLayer)),
  );

  it.effect("keeps the committed publication when post-commit verification is lost", () => {
    const capture = makeCapturedLogger();
    return Effect.gen(function* () {
      const { fs: realFs, path, root, directory } = yield* tempImages;
      // Only the published destination (.png) is stat'd after the hard-link commit, so a
      // defecting stat here simulates verification I/O loss immediately after commit.
      const hostileFs: typeof realFs = Object.assign({}, realFs, {
        stat: (pathArg: Parameters<typeof realFs.stat>[0]) =>
          String(pathArg).endsWith(".png")
            ? Effect.die("verification-io-loss")
            : realFs.stat(pathArg),
      });
      const output = makeImageOutput({ fs: hostileFs, path, sharp: pngSharp });
      const content = bytes("committed-image-bytes");
      const destination = yield* output.persistImage(
        directory,
        root,
        content,
        "png",
        "provider/id",
      );
      expect(yield* realFs.exists(destination)).toBe(true);
      expect(Array.from(yield* realFs.readFile(destination))).toEqual(Array.from(content));
      expect(
        (yield* realFs.readDirectory(directory)).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
      expect(capture.entries).toHaveLength(1);
    }).pipe(provideBuiltLayer(Layer.merge(nodePlatformLayer, capture.layer)));
  });
});
