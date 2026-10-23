import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { fileLayer } from "../platform/node.ts";

export const galleryDirectory = (
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  const directory = environment["PRESENTATION_GALLERY"];
  return directory === undefined || directory === "" ? undefined : directory;
};

export const writeGallerySection = Effect.fn("PresentationGallery.writeSection")(function* (
  directory: string,
  name: string,
  lines: readonly string[],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(directory, `${name}.txt`), `${lines.join("\n")}\n`);
}, Effect.provide(fileLayer));
