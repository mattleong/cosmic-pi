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
  getWriteDiffSkipReason,
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

test("write diff complexity skips rewrites but keeps localized changes", () => {
  const beforeRewrite = Array.from({ length: 2_000 }, (_, index) => `before ${index}`).join("\n");
  const afterRewrite = Array.from({ length: 2_000 }, (_, index) => `after ${index}`).join("\n");
  assert.equal(shouldSkipWriteDiffComplexity(beforeRewrite, afterRewrite), true);

  const lines = Array.from({ length: 10_000 }, (_, index) => `line ${index}`);
  const beforeLocalized = lines.join("\n");
  lines[5_000] = "changed";
  assert.equal(shouldSkipWriteDiffComplexity(beforeLocalized, lines.join("\n")), false);
});
