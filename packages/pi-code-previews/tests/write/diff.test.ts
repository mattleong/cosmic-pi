// Test/benchmark boundary intentionally exercises native Pi, Node, Promise, timer, and environment APIs.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/globalConsole:off
// @effect-diagnostics effect/globalDate:off
// @effect-diagnostics effect/strictEffectProvide:off
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { test } from "vitest";
import {
  getWriteDiffSkipReason,
  MAX_WRITE_DIFF_BYTES,
  readExistingFileForPreviewEffect,
  shouldSkipWriteDiffComplexity,
} from "../../src/write/diff";
import { resolvePreviewPath } from "../../src/paths/resolve";

test("resolvePreviewPath mirrors pi path expansion", () => {
  assert.equal(resolvePreviewPath("@src/file.ts", "/tmp/project"), "/tmp/project/src/file.ts");
  assert.equal(resolvePreviewPath("src/file.ts", "/tmp/project"), "/tmp/project/src/file.ts");
  assert.equal(resolvePreviewPath("@~/file.ts", "/tmp/project"), join(homedir(), "file.ts"));
  assert.equal(resolvePreviewPath("~/file.ts", "/tmp/project"), join(homedir(), "file.ts"));
});

test("write diff skip reasons only use threshold comparisons for size limits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-code-previews-skip-reason-"));
  try {
    await mkdir(join(dir, "folder"));
    const skippedDirectory = await Effect.runPromise(
      readExistingFileForPreviewEffect("folder", dir, "after").pipe(
        Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
      ),
    );
    assert.equal(skippedDirectory?.kind, "skipped");
    const reason = getWriteDiffSkipReason(skippedDirectory, "after") ?? "";
    assert.match(reason, /previous path is not a regular file \([^>]+\)$/);
    assert.doesNotMatch(reason, />/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readExistingFileForPreview returns bounded previous content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-code-previews-"));
  try {
    await writeFile(join(dir, "small.txt"), "before", "utf8");
    assert.deepEqual(
      await Effect.runPromise(
        readExistingFileForPreviewEffect("small.txt", dir, "after").pipe(
          Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
        ),
      ),
      {
        kind: "content",
        content: "before",
      },
    );

    await writeFile(join(dir, "large.txt"), "x".repeat(MAX_WRITE_DIFF_BYTES + 1), "utf8");
    const skipped = await Effect.runPromise(
      readExistingFileForPreviewEffect("large.txt", dir, "after").pipe(
        Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
      ),
    );
    assert.equal(skipped?.kind, "skipped");
    assert.match(getWriteDiffSkipReason(skipped, "after") ?? "", /previous file too large/);
  } finally {
    await rm(dir, { recursive: true, force: true });
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
