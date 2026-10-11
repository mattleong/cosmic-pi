import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { fileLayer } from "../platform/node.ts";

export const galleryDirectory = (
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined => environment["PRESENTATION_GALLERY"] || undefined;

export const writeGallerySection = (directory: string, name: string, lines: readonly string[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFileString(path.join(directory, `${name}.txt`), `${lines.join("\n")}\n`);
  }).pipe(Effect.provide(fileLayer));
