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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { JsonDocumentStore } from "pi-cosmic-core";
import { test } from "vitest";
import { setActivePlatformRunner } from "../boundary/platform";
import { makeCodePreviewRuntime } from "../boundary/runtime";
import { ShikiAdapter } from "../boundary/shiki";
import {
  getWriteDiffSkipReason,
  MAX_WRITE_DIFF_BYTES,
  readExistingFileForPreview,
  shouldSkipWriteDiffComplexity,
} from "./diff";
import { resolvePreviewPath } from "../paths/resolve";

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
    const skippedDirectory = await readExistingFileForPreview("folder", dir, "after");
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
    assert.deepEqual(await readExistingFileForPreview("small.txt", dir, "after"), {
      kind: "content",
      content: "before",
    });

    await writeFile(join(dir, "large.txt"), "x".repeat(MAX_WRITE_DIFF_BYTES + 1), "utf8");
    const skipped = await readExistingFileForPreview("large.txt", dir, "after");
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

test("active-session preview reads are interrupted by runtime disposal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-code-previews-owned-read-"));
  await writeFile(join(dir, "target.txt"), "before", "utf8");
  const fs = await Effect.runPromise(
    FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)),
  );
  let started: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let interrupted = 0;
  const delayed = FileSystem.FileSystem.of({
    ...fs,
    open: () =>
      Effect.sync(() => started?.()).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => interrupted++)),
      ),
  });
  const fileAndPath = Layer.merge(Layer.succeed(FileSystem.FileSystem, delayed), NodePath.layer);
  const platform = JsonDocumentStore.layer.pipe(Layer.provideMerge(fileAndPath));
  const layer = Layer.merge(platform, ShikiAdapter.layer);
  const runtime = makeCodePreviewRuntime({} as ExtensionAPI, layer);
  setActivePlatformRunner({
    run: (effect, signal) => runtime.run(effect, signal),
    runShiki: (effect, signal) => runtime.run(effect, signal),
    forkShiki: (effect) => runtime.fork(effect),
  });
  try {
    const read = readExistingFileForPreview("target.txt", dir, "after");
    await pending;
    await runtime.dispose();
    await assert.rejects(read);
    assert.equal(interrupted, 1);
  } finally {
    setActivePlatformRunner(undefined);
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
