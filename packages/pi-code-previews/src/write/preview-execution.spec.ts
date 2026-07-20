// Test boundary intentionally uses Node temp-directory helpers.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/strictEffectProvide:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
import assert from "node:assert/strict";
import {
  chmod,
  link as createLink,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { JsonDocumentStore, nodeFilePlatformLayer } from "pi-cosmic-core";
import { setActivePlatformRunner } from "../boundary/platform";
import { makeCodePreviewRuntime } from "../boundary/runtime";
import { ShikiAdapter } from "../boundary/shiki";
import { resolvePreviewPath } from "../paths/resolve";
import { executeWriteWithPreview, executeWriteWithPreviewEffect } from "./preview-execution";

it.effect("writes preserve an existing symlink and update its target", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "pi-code-preview-link-")));
    yield* Effect.promise(() => writeFile(join(dir, "target.txt"), "before"));
    yield* Effect.promise(() => symlink("target.txt", join(dir, "link.txt")));
    yield* executeWriteWithPreviewEffect("tool-link", "link.txt", "after", dir);
    assert.equal(yield* Effect.promise(() => readFile(join(dir, "target.txt"), "utf8")), "after");
    assert.equal(
      (yield* Effect.promise(() => lstat(join(dir, "link.txt")))).isSymbolicLink(),
      true,
    );
    yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
  }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect("writes follow mixed relative and absolute final symlink chains", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "pi-code-preview-chain-")));
    const target = join(dir, "target.txt");
    yield* Effect.promise(() => writeFile(target, "before"));
    yield* Effect.promise(() => symlink(target, join(dir, "absolute-link.txt")));
    yield* Effect.promise(() => symlink("absolute-link.txt", join(dir, "relative-link.txt")));
    yield* executeWriteWithPreviewEffect("tool-chain", "relative-link.txt", "after", dir);
    assert.equal(yield* Effect.promise(() => readFile(target, "utf8")), "after");
    assert.equal(
      (yield* Effect.promise(() => lstat(join(dir, "relative-link.txt")))).isSymbolicLink(),
      true,
    );
    assert.equal(
      (yield* Effect.promise(() => lstat(join(dir, "absolute-link.txt")))).isSymbolicLink(),
      true,
    );
    yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
  }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect("resolves relative final links from their physical symlinked directory", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "pi-code-preview-parent-link-")),
    );
    const real = join(dir, "real");
    const nested = join(real, "sub");
    yield* Effect.promise(() => mkdir(nested, { recursive: true }));
    yield* Effect.promise(() => writeFile(join(real, "target.txt"), "before"));
    yield* Effect.promise(() => symlink("real/sub", join(dir, "alias")));
    yield* Effect.promise(() => symlink("../target.txt", join(nested, "leaf")));

    yield* executeWriteWithPreviewEffect("tool-parent-link", "alias/leaf", "after", dir);

    assert.equal(yield* Effect.promise(() => readFile(join(real, "target.txt"), "utf8")), "after");
    assert.equal(
      yield* Effect.promise(() =>
        readFile(join(dir, "target.txt"), "utf8").then(
          () => true,
          () => false,
        ),
      ),
      false,
    );
    yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
  }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect("writes preserve target inode, mode, hard-link aliases, and open descriptors", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "pi-code-preview-inode-")));
    const target = join(dir, "target.txt");
    const alias = join(dir, "alias.txt");
    yield* Effect.promise(() => writeFile(target, "before"));
    yield* Effect.promise(() => chmod(target, 0o640));
    yield* Effect.promise(() => createLink(target, alias));
    const before = yield* Effect.promise(() => stat(target));
    const descriptor = yield* Effect.promise(() => open(target, "r"));
    try {
      yield* executeWriteWithPreviewEffect("tool-inode", "target.txt", "after", dir);
      const after = yield* Effect.promise(() => stat(target));
      const aliasAfter = yield* Effect.promise(() => stat(alias));
      const buffer = Buffer.alloc(5);
      const read = yield* Effect.promise(() => descriptor.read(buffer, 0, buffer.length, 0));
      assert.equal(buffer.subarray(0, read.bytesRead).toString("utf8"), "after");
      assert.equal(yield* Effect.promise(() => readFile(alias, "utf8")), "after");
      assert.equal(after.ino, before.ino);
      assert.equal(aliasAfter.ino, before.ino);
      assert.equal(after.mode & 0o777, 0o640);
    } finally {
      yield* Effect.promise(() => descriptor.close());
      yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect("new files use normal writeFile creation mode under the process umask", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "pi-code-preview-mode-")));
    const control = join(dir, "control.txt");
    const preview = join(dir, "preview.txt");
    yield* Effect.promise(() => writeFile(control, "control"));
    yield* executeWriteWithPreviewEffect("tool-mode", "preview.txt", "preview", dir);
    const controlMode = (yield* Effect.promise(() => stat(control))).mode & 0o777;
    const previewMode = (yield* Effect.promise(() => stat(preview))).mode & 0o777;
    assert.equal(previewMode, controlMode);
    yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
  }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect("dangling symlinks do not create target directories", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "pi-code-preview-dangling-")));
    const link = join(dir, "link.txt");
    const missingDirectory = join(dir, "missing");
    yield* Effect.promise(() => symlink("missing/target.txt", link));
    const error = yield* Effect.flip(
      executeWriteWithPreviewEffect("tool-dangling", "link.txt", "after", dir),
    );
    assert.equal(error.operation, "write");
    assert.equal((yield* Effect.promise(() => lstat(link))).isSymbolicLink(), true);
    const created = yield* Effect.promise(() =>
      lstat(missingDirectory).then(
        () => true,
        () => false,
      ),
    );
    assert.equal(created, false);
    yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
  }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect("cyclic and over-depth final symlink chains fail without replacing links", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "pi-code-preview-cycle-")));
    yield* Effect.promise(() => symlink("b.txt", join(dir, "a.txt")));
    yield* Effect.promise(() => symlink("a.txt", join(dir, "b.txt")));
    yield* Effect.flip(executeWriteWithPreviewEffect("tool-cycle", "a.txt", "after", dir));
    assert.equal((yield* Effect.promise(() => lstat(join(dir, "a.txt")))).isSymbolicLink(), true);
    assert.equal((yield* Effect.promise(() => lstat(join(dir, "b.txt")))).isSymbolicLink(), true);

    yield* Effect.promise(() => writeFile(join(dir, "deep-target.txt"), "before"));
    for (let index = 0; index <= 40; index++) {
      const destination = index === 40 ? "deep-target.txt" : `deep-${index + 1}.txt`;
      yield* Effect.promise(() => symlink(destination, join(dir, `deep-${index}.txt`)));
    }
    yield* Effect.flip(executeWriteWithPreviewEffect("tool-deep", "deep-0.txt", "after", dir));
    assert.equal(
      yield* Effect.promise(() => readFile(join(dir, "deep-target.txt"), "utf8")),
      "before",
    );
    assert.equal(
      (yield* Effect.promise(() => lstat(join(dir, "deep-0.txt")))).isSymbolicLink(),
      true,
    );
    yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
  }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect("interruption keeps the path semaphore until an uninterruptible write settles", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "pi-code-preview-write-")));
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const fs = yield* FileSystem.FileSystem;
    const delayedFileSystem = Layer.succeed(
      FileSystem.FileSystem,
      FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (path, content, options) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(fs.writeFileString(path, content, options)),
          ),
      }),
    );
    const providers = Layer.merge(delayedFileSystem, NodePath.layer);
    const first = yield* executeWriteWithPreviewEffect("tool-1", "target.txt", "first", dir).pipe(
      Effect.provide(providers),
      Effect.forkScoped,
    );
    yield* Deferred.await(started);
    const second = yield* executeWriteWithPreviewEffect("tool-2", "target.txt", "second", dir).pipe(
      Effect.provide(providers),
      Effect.forkScoped,
    );
    yield* Fiber.interrupt(first).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    const pendingBeforeRelease = second.pollUnsafe();
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(second);
    assert.equal(pendingBeforeRelease, undefined);
    assert.equal(yield* Effect.promise(() => readFile(join(dir, "target.txt"), "utf8")), "second");
    yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it("public abort keeps Pi's mutation queue locked until the uninterruptible write settles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-code-preview-public-abort-"));
  let releaseWrite: (() => void) | undefined;
  let writeStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    writeStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const fs = await Effect.runPromise(
    FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)),
  );
  const delayed = FileSystem.FileSystem.of({
    ...fs,
    writeFileString: (path, content, options) =>
      Effect.sync(() => writeStarted?.()).pipe(
        Effect.andThen(Effect.promise(() => released)),
        Effect.andThen(fs.writeFileString(path, content, options)),
      ),
  });
  setActivePlatformRunner({
    run: (effect, signal) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, delayed),
          Effect.provide(nodeFilePlatformLayer),
        ),
        signal ? { signal } : undefined,
      ),
    runShiki: (effect, signal) =>
      Effect.runPromise(
        effect.pipe(Effect.provideService(ShikiAdapter, ShikiAdapter.live)),
        signal ? { signal } : undefined,
      ),
    forkShiki: (effect) =>
      Effect.runFork(effect.pipe(Effect.provideService(ShikiAdapter, ShikiAdapter.live))),
  });
  try {
    const controller = new AbortController();
    const first = executeWriteWithPreview(
      "public-tool",
      "target.txt",
      "after",
      dir,
      controller.signal,
    );
    await started;
    controller.abort();

    let secondAcquired = false;
    const second = withFileMutationQueue(resolvePreviewPath("target.txt", dir), async () => {
      secondAcquired = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(secondAcquired, false);

    releaseWrite?.();
    await assert.rejects(first, { message: "Operation aborted" });
    await second;
    assert.equal(secondAcquired, true);
    assert.equal(await readFile(join(dir, "target.txt"), "utf8"), "after");
  } finally {
    setActivePlatformRunner(undefined);
    releaseWrite?.();
    await rm(dir, { recursive: true, force: true });
  }
});

it("session disposal waits for an uninterruptible write and its mutation lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-code-preview-owned-write-"));
  const fs = await Effect.runPromise(
    FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)),
  );
  let started: (() => void) | undefined;
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayed = FileSystem.FileSystem.of({
    ...fs,
    writeFileString: (path, content, options) =>
      Effect.sync(() => started?.()).pipe(
        Effect.andThen(Effect.promise(() => released)),
        Effect.andThen(fs.writeFileString(path, content, options)),
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
    const write = executeWriteWithPreview("owned", "target.txt", "after", dir, undefined);
    await pending;
    let disposed = false;
    const disposal = runtime.dispose().then(() => {
      disposed = true;
    });
    let secondAcquired = false;
    const second = withFileMutationQueue(resolvePreviewPath("target.txt", dir), async () => {
      secondAcquired = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(disposed, false);
    assert.equal(secondAcquired, false);
    release?.();
    await assert.rejects(write);
    await disposal;
    await second;
    assert.equal(disposed, true);
    assert.equal(secondAcquired, true);
    assert.equal(await readFile(join(dir, "target.txt"), "utf8"), "after");
  } finally {
    setActivePlatformRunner(undefined);
    release?.();
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
