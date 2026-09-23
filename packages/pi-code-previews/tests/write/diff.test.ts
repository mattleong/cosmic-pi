// Explicit test entry-point Effects drive the write diff boundaries.
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Layer from "effect/Layer";
import { provideBuiltLayer } from "pi-cosmic-core";
import { test } from "vitest";
import { effectTest, step } from "../support/effect-test";
import { defaultCodePreviewPerformanceConfig } from "../../src/config/defaults";
import {
  getWriteDiffGuard,
  getWriteDiffSkipReason,
  hasWriteDiffSizeEvidence,
  readExistingFileForPreviewEffect,
  shouldSkipWriteDiffComplexity,
} from "../../src/write/diff";
import { resolvePreviewPath } from "../../src/paths/resolve";

// Raw Node builtin access for test scaffolding, mirroring pi-cosmic-core's platform boundary.
const nodeFsModule = process.getBuiltinModule("node:fs");
const nodePathModule = process.getBuiltinModule("node:path");
if (!nodeFsModule || !nodePathModule) throw new Error("Node fs/path builtins are unavailable.");
const { mkdir, mkdtemp, rm, writeFile } = nodeFsModule.promises;
const { join } = nodePathModule;

const previewFileLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer);

test("resolvePreviewPath mirrors pi path expansion", () => {
  assert.equal(resolvePreviewPath("@src/file.ts", "/tmp/project"), "/tmp/project/src/file.ts");
  assert.equal(resolvePreviewPath("src/file.ts", "/tmp/project"), "/tmp/project/src/file.ts");
  assert.equal(resolvePreviewPath("@~/file.ts", "/tmp/project"), join(homedir(), "file.ts"));
  assert.equal(resolvePreviewPath("~/file.ts", "/tmp/project"), join(homedir(), "file.ts"));
});

effectTest("write diff skip reasons only use threshold comparisons for size limits", function* () {
  const dir = yield* step(() => mkdtemp(join(tmpdir(), "pi-code-previews-skip-reason-")));
  try {
    yield* step(() => mkdir(join(dir, "folder")));
    const skippedDirectory = yield* readExistingFileForPreviewEffect("folder", dir, "after").pipe(
      provideBuiltLayer(previewFileLayer),
    );
    assert.equal(skippedDirectory?.kind, "skipped");
    const reason = getWriteDiffSkipReason(skippedDirectory, "after") ?? "";
    assert.match(reason, /previous path is not a regular file \([^>]+\)$/);
    assert.doesNotMatch(reason, />/);
  } finally {
    yield* step(() => rm(dir, { recursive: true, force: true }));
  }
});

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

effectTest("readExistingFileForPreview returns bounded previous content", function* () {
  const dir = yield* step(() => mkdtemp(join(tmpdir(), "pi-code-previews-")));
  try {
    yield* step(() => writeFile(join(dir, "small.txt"), "before", "utf8"));
    assert.deepEqual(
      yield* readExistingFileForPreviewEffect("small.txt", dir, "after").pipe(
        provideBuiltLayer(previewFileLayer),
      ),
      {
        kind: "content",
        content: "before",
      },
    );

    yield* step(() =>
      writeFile(
        join(dir, "large.txt"),
        "x".repeat(defaultCodePreviewPerformanceConfig.maxWriteDiffBytes + 1),
        "utf8",
      ),
    );
    const skipped = yield* readExistingFileForPreviewEffect("large.txt", dir, "after").pipe(
      provideBuiltLayer(previewFileLayer),
    );
    assert.equal(skipped?.kind, "skipped");
    assert.match(getWriteDiffSkipReason(skipped, "after") ?? "", /previous file too large/);
  } finally {
    yield* step(() => rm(dir, { recursive: true, force: true }));
  }
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
