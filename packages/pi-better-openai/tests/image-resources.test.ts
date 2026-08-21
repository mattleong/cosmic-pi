// @effect-diagnostics effect/strictEffectProvide:off
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";
import { nodePlatformLayer } from "pi-cosmic-core";
import type { SharpAdapterContract } from "../src/boundary/sharp.ts";
import { makeImageOutput } from "../src/image/output.ts";
import { parseImageSse } from "../src/image/stream.ts";

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);

const sharp: SharpAdapterContract = {
  decode: () => Effect.succeed({ format: "png" }),
};

describe("OpenAI image resources", () => {
  it.effect("finalizes an owned response stream when image decoding is interrupted", () => {
    let finalized = 0;
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const pendingBytes = yield* Deferred.make<Uint8Array>();
      const body = Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(
        Stream.drain,
        Stream.concat(Stream.fromEffect(Deferred.await(pendingBytes))),
        Stream.ensuring(
          Effect.sync(() => {
            finalized++;
          }),
        ),
      );
      const fiber = yield* parseImageSse(body, "image/png").pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(finalized).toBe(1);
    });
  });

  it.effect("publishes atomically and preserves an existing destination on collision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "pi-openai-image-test-" });
      const directory = path.join(root, "images");
      const output = makeImageOutput({ fs, path, sharp });
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
        .pipe(Random.withSeed("collision-seed"), Effect.result);
      expect(collision._tag).toBe("Failure");
      if (collision._tag === "Failure") {
        expect(collision.failure._tag).toBe("OpenAIImageError");
        if (collision.failure._tag === "OpenAIImageError")
          expect(collision.failure.operation).toBe("save");
      }
      expect(Array.from(yield* fs.readFile(destination))).toEqual(Array.from(content));
      const visible = yield* fs.readDirectory(directory);
      expect(visible).toHaveLength(1);
      expect(visible.some((name) => name.endsWith(".tmp"))).toBe(false);
    }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it.effect("keeps the committed publication when post-commit verification is lost", () =>
    Effect.gen(function* () {
      const realFs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* realFs.makeTempDirectoryScoped({ prefix: "pi-openai-image-test-" });
      const directory = path.join(root, "images");
      // Only the published destination (.png) is stat'd after the hard-link commit, so a
      // defecting stat here simulates verification I/O loss immediately after commit.
      const hostileFs: typeof realFs = Object.assign({}, realFs, {
        stat: (pathArg: Parameters<typeof realFs.stat>[0]) =>
          String(pathArg).endsWith(".png")
            ? Effect.die("verification-io-loss")
            : realFs.stat(pathArg),
      });
      const output = makeImageOutput({ fs: hostileFs, path, sharp });
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
    }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
