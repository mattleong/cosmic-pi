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
import { layer } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { executeWriteWithPreviewEffect } from "./preview-execution";
import { CodePreviewWriteService } from "./service";

layer(CodePreviewWriteService.layer)("session write service", (it) => {
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

      assert.equal(
        yield* Effect.promise(() => readFile(join(real, "target.txt"), "utf8")),
        "after",
      );
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
      const second = yield* executeWriteWithPreviewEffect(
        "tool-2",
        "target.txt",
        "second",
        dir,
      ).pipe(Effect.provide(providers), Effect.forkScoped);
      yield* Fiber.interrupt(first).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const pendingBeforeRelease = second.pollUnsafe();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(second);
      assert.equal(pendingBeforeRelease, undefined);
      assert.equal(
        yield* Effect.promise(() => readFile(join(dir, "target.txt"), "utf8")),
        "second",
      );
      yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
});
