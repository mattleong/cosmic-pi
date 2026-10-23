import assert from "node:assert/strict";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { runBoundedProcessNode } from "pi-cosmic-core";
import { provideBuiltLayer } from "pi-cosmic-core/testing";
import { test } from "vitest";
import { defaultCodePreviewPerformanceConfig } from "../../src/config/defaults";
import {
  getWriteDiffSkipReason,
  hasWriteDiffSizeEvidence,
  readExistingFileForPreviewEffect,
  shouldSkipWriteDiffComplexity,
} from "../../src/write/diff";

const previewFileLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer);

it.effect("previous content is bounded, exact and skipped with measured reasons", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { join } = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-code-previews-" });
    const read = (name: string) => readExistingFileForPreviewEffect(join(dir, name), "after");
    yield* fs.writeFileString(join(dir, "small.txt"), "before");
    assert.deepEqual(yield* read("small.txt"), { kind: "content", content: "before" });
    yield* fs.writeFileString(join(dir, "bom.txt"), "\uFEFFbefore");
    assert.deepEqual(yield* read("bom.txt"), { kind: "content", content: "\uFEFFbefore" });

    const maxBytes = defaultCodePreviewPerformanceConfig.maxWriteDiffBytes;
    yield* fs.writeFileString(join(dir, "large.txt"), "x".repeat(maxBytes + 1));
    const large = yield* read("large.txt");
    assert.equal(large?.kind, "skipped");
    assert.match(getWriteDiffSkipReason(large, "after") ?? "", /previous file too large/);

    yield* fs.makeDirectory(join(dir, "folder"));
    const folder = getWriteDiffSkipReason(yield* read("folder"), "after") ?? "";
    assert.match(folder, /previous path is not a regular file \([^>]+\)$/);
  }).pipe(provideBuiltLayer(previewFileLayer)),
);

it.effect("previous content stays complete and bounded across short filesystem reads", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { join } = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-code-previews-short-read-" });
    const path = join(dir, "unicode.txt");
    const content = "\uFEFFbefore 😀\nlast line";
    yield* fs.writeFileString(path, content);
    let chunkBytes = 2;
    const shortReads: FileSystem.FileSystem = {
      ...fs,
      open: (filePath, options) =>
        fs.open(filePath, options).pipe(
          Effect.map(
            (file): FileSystem.File => ({
              [FileSystem.FileTypeId]: FileSystem.FileTypeId,
              stat: file.stat,
              seek: (offset, from) => file.seek(offset, from),
              sync: file.sync,
              read: (buffer) => file.read(buffer),
              readAlloc: (size) => file.readAlloc(Math.min(size, chunkBytes)),
              truncate: (length) => file.truncate(length),
              write: (buffer) => file.write(buffer),
              writeAll: (buffer) => file.writeAll(buffer),
            }),
          ),
        ),
    };
    const before = yield* readExistingFileForPreviewEffect(path, "after").pipe(
      Effect.provideService(FileSystem.FileSystem, shortReads),
    );
    assert.deepEqual(before, { kind: "content", content });

    const initialInfo = yield* fs.stat(path);
    const maxBytes = defaultCodePreviewPerformanceConfig.maxWriteDiffBytes;
    yield* fs.writeFileString(path, "x".repeat(maxBytes + 1));
    chunkBytes = 16 * 1024;
    const grown = yield* readExistingFileForPreviewEffect(path, "after").pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...shortReads,
        stat: () => Effect.succeed(initialInfo),
      }),
    );
    assert.equal(hasWriteDiffSizeEvidence(grown), true);
    if (grown?.kind !== "skipped") assert.fail("growing file exceeded the preview bound");
    assert.equal(grown.byteLength, maxBytes + 1);
  }).pipe(provideBuiltLayer(previewFileLayer)),
);

it.effect("a named pipe is skipped without waiting for a writer", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { join } = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-code-previews-fifo-" });
    const mkfifo = yield* runBoundedProcessNode({
      executable: "mkfifo",
      args: [join(dir, "pipe")],
      stdoutLimitBytes: 4_096,
      stderrLimitBytes: 4_096,
      timeoutMillis: 5_000,
    });
    assert.equal(mkfifo.code, 0);
    const skipped = yield* readExistingFileForPreviewEffect(join(dir, "pipe"), "after");
    assert.match(getWriteDiffSkipReason(skipped, "after") ?? "", /not a regular file/);
  }).pipe(provideBuiltLayer(previewFileLayer)),
);

test("write diff complexity skips rewrites but keeps localized changes", () => {
  const beforeRewrite = Array.from({ length: 2_000 }, (_, index) => `before ${index}`).join("\n");
  const afterRewrite = Array.from({ length: 2_000 }, (_, index) => `after ${index}`).join("\n");
  assert.equal(shouldSkipWriteDiffComplexity(beforeRewrite, afterRewrite), true);

  const lines = Array.from({ length: 10_000 }, (_, index) => `line ${index}`);
  const beforeLocalized = lines.join("\n");
  lines[5_000] = "changed";
  assert.equal(shouldSkipWriteDiffComplexity(beforeLocalized, lines.join("\n")), false);
});
