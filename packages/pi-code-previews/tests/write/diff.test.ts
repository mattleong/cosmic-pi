import assert from "node:assert/strict";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { provideBuiltLayer } from "pi-cosmic-core";
import { test } from "vitest";
import { defaultCodePreviewPerformanceConfig } from "../../src/config/defaults";
import {
  getWriteDiffGuard,
  getWriteDiffSkipReason,
  hasWriteDiffSizeEvidence,
  readExistingFileForPreviewEffect,
  shouldSkipWriteDiffComplexity,
} from "../../src/write/diff";

const nodePathModule = process.getBuiltinModule("node:path");
const childProcessModule = process.getBuiltinModule("node:child_process");
if (!nodePathModule || !childProcessModule) throw new Error("Node builtins are unavailable.");
const join = nodePathModule.join.bind(nodePathModule);

const previewFileLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer);

it.effect("previous content is bounded, exact and skipped with measured reasons", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
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

it.effect.skipIf(process.platform === "win32")(
  "a named pipe is skipped without waiting for a writer",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-code-previews-fifo-" });
      childProcessModule.execFileSync("mkfifo", [join(dir, "pipe")]);
      const skipped = yield* readExistingFileForPreviewEffect(join(dir, "pipe"), "after");
      assert.match(getWriteDiffSkipReason(skipped, "after") ?? "", /not a regular file/);
    }).pipe(provideBuiltLayer(previewFileLayer)),
);

test("write diff skip reasons reject malformed or non-current skipped details", () => {
  assert.equal(
    getWriteDiffSkipReason({ kind: "skipped", reason: "missing bound" }, "after"),
    undefined,
  );
  assert.equal(
    getWriteDiffSkipReason(
      { kind: "skipped", reason: "forged", maxBytes: 100, unexpected: true },
      "after",
    ),
    undefined,
  );
  assert.equal(
    getWriteDiffSkipReason({ kind: "skipped", reason: "bounded", maxBytes: 100 }, "after"),
    "bounded",
  );
  const measured = {
    kind: "skipped",
    reason: "previous file too large",
    byteLength: 101,
    maxBytes: 100,
    sizeExceeded: true,
  };
  assert.equal(hasWriteDiffSizeEvidence(measured), true);
  assert.equal(hasWriteDiffSizeEvidence({ ...measured, reason: " " }), false);
  assert.equal(hasWriteDiffSizeEvidence({ ...measured, byteLength: 100 }), false);
  assert.equal(hasWriteDiffSizeEvidence({ ...measured, unexpected: true }), false);
});

test("write diff guards prioritize measured UTF-8 size over rewrite complexity", () => {
  assert.equal(getWriteDiffGuard("旧\n", "新\n", 7, 0), "size");
  assert.equal(getWriteDiffGuard("旧\n", "新\n", 8, 0), "complexity");
  assert.equal(getWriteDiffGuard("abc", "def", 5, 0), "size");
  assert.equal(getWriteDiffGuard("old", "new", 6, 1), undefined);
  assert.equal(getWriteDiffGuard("x", "x", 2, 0), undefined);
});

test("write diff complexity skips rewrites but keeps localized changes", () => {
  const beforeRewrite = Array.from({ length: 2_000 }, (_, index) => `before ${index}`).join("\n");
  const afterRewrite = Array.from({ length: 2_000 }, (_, index) => `after ${index}`).join("\n");
  assert.equal(shouldSkipWriteDiffComplexity(beforeRewrite, afterRewrite), true);

  const lines = Array.from({ length: 10_000 }, (_, index) => `line ${index}`);
  const beforeLocalized = lines.join("\n");
  lines[5_000] = "changed";
  assert.equal(shouldSkipWriteDiffComplexity(beforeLocalized, lines.join("\n")), false);
});
