import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import { provideBuiltLayer } from "pi-cosmic-core/testing";
import { nodePlatformLayer } from "pi-cosmic-core";
import { imageOutput } from "../src/image/output.ts";
import { bytes, pngSharp } from "./helpers.ts";
import { OpenAIImageError } from "../src/image/types.ts";

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
      const output = imageOutput({ fs, path, sharp: pngSharp });
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
      expect(collision).toBeInstanceOf(OpenAIImageError);
      expect(collision).toMatchObject({ operation: "save" });
      expect(Array.from(yield* fs.readFile(destination))).toEqual(Array.from(content));
      const visible = yield* fs.readDirectory(directory);
      expect(visible).toHaveLength(1);
      expect(visible.some((name) => name.endsWith(".tmp"))).toBe(false);
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
      const output = imageOutput({ fs: hostileFs, path, sharp: pngSharp });

      const failure = yield* output
        .persistImage(directory, root, bytes("owned-image-bytes"), "png", "provider/id")
        .pipe(Effect.flip);

      expect(failure).toBeInstanceOf(OpenAIImageError);
      expect(failure).toMatchObject({ operation: "save" });
      const publishedDestination = destination;
      if (!publishedDestination) return yield* Effect.die("destination was not published");
      expect(Array.from(yield* realFs.readFile(publishedDestination))).toEqual(
        Array.from(foreignBytes),
      );
      expect(
        (yield* realFs.readDirectory(directory)).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
      return undefined;
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
      const output = imageOutput({ fs: hostileFs, path, sharp: pngSharp });
      const fiber = yield* output
        .persistImage(directory, root, bytes("owned-image-bytes"), "png", "provider/id")
        .pipe(Effect.forkScoped);

      yield* Deferred.await(writeStarted);
      yield* Fiber.interrupt(fiber);

      expect(yield* realFs.readDirectory(directory)).toEqual([]);
    }).pipe(provideBuiltLayer(nodePlatformLayer)),
  );
});
