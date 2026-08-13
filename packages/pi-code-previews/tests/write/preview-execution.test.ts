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
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expectTypeOf, test } from "vitest";
import {
  type CodePreviewWriteDetails,
  executeWriteWithPreviewEffect,
  withCodePreviewBeforeWrite,
} from "../../src/write/preview-execution";
import { lookupBeforeWrite } from "../../src/write/projection";
import { CodePreviewWriteService } from "../../src/write/service";

class TestFileSystemError extends Schema.TaggedError<TestFileSystemError>()("TestFileSystemError", {
  operation: Schema.String,
}) {}

const testFileSystem = <A>(
  operation: string,
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, TestFileSystemError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: () => new TestFileSystemError({ operation }),
  });

const withTempDirectory = <A, E, R>(
  prefix: string,
  use: (directory: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | TestFileSystemError, R> =>
  Effect.acquireUseRelease(
    testFileSystem("make temp directory", () => mkdtemp(join(tmpdir(), prefix))),
    use,
    (directory) =>
      testFileSystem("remove temp directory", () =>
        rm(directory, { recursive: true, force: true }),
      ),
  );

test("before-write details replace undefined details and preserve object fields", async () => {
  const resultWithoutDetails: AgentToolResult<undefined> = { content: [], details: undefined };
  const enrichedWithoutDetails = await withCodePreviewBeforeWrite(resultWithoutDetails, {
    kind: "content",
    content: "before",
  });
  expectTypeOf(enrichedWithoutDetails.details).toEqualTypeOf<CodePreviewWriteDetails>();
  assert.deepEqual(enrichedWithoutDetails.details, {
    codePreviewBeforeWrite: { kind: "content", byteLength: 6 },
  });

  const resultWithDetails: AgentToolResult<{ readonly existing: "kept" }> = {
    content: [],
    details: { existing: "kept" },
  };
  const enrichedWithDetails = await withCodePreviewBeforeWrite(resultWithDetails, undefined);
  expectTypeOf(enrichedWithDetails.details.existing).toEqualTypeOf<"kept">();
  expectTypeOf(enrichedWithDetails.details.codePreviewBeforeWrite).toEqualTypeOf<
    CodePreviewWriteDetails["codePreviewBeforeWrite"]
  >();
  assert.deepEqual(enrichedWithDetails.details, {
    existing: "kept",
    codePreviewBeforeWrite: undefined,
  });
});

layer(CodePreviewWriteService.layer)("session write service", (it) => {
  it.effect("writes preserve an existing symlink and update its target", () =>
    withTempDirectory("pi-code-preview-link-", (dir) =>
      Effect.gen(function* () {
        yield* testFileSystem("write fixture", () => writeFile(join(dir, "target.txt"), "before"));
        yield* testFileSystem("create symbolic link", () =>
          symlink("target.txt", join(dir, "link.txt")),
        );
        yield* executeWriteWithPreviewEffect("tool-link", "link.txt", "after", dir);
        assert.equal(
          yield* testFileSystem("read target", () => readFile(join(dir, "target.txt"), "utf8")),
          "after",
        );
        assert.equal(
          (yield* testFileSystem("inspect symbolic link", () =>
            lstat(join(dir, "link.txt")),
          )).isSymbolicLink(),
          true,
        );
      }),
    ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
  );

  it.effect("writes follow mixed relative and absolute final symlink chains", () =>
    withTempDirectory("pi-code-preview-chain-", (dir) =>
      Effect.gen(function* () {
        const target = join(dir, "target.txt");
        yield* testFileSystem("write fixture", () => writeFile(target, "before"));
        yield* testFileSystem("create absolute symbolic link", () =>
          symlink(target, join(dir, "absolute-link.txt")),
        );
        yield* testFileSystem("create relative symbolic link", () =>
          symlink("absolute-link.txt", join(dir, "relative-link.txt")),
        );
        yield* executeWriteWithPreviewEffect("tool-chain", "relative-link.txt", "after", dir);
        assert.equal(yield* testFileSystem("read target", () => readFile(target, "utf8")), "after");
        assert.equal(
          (yield* testFileSystem("inspect relative symbolic link", () =>
            lstat(join(dir, "relative-link.txt")),
          )).isSymbolicLink(),
          true,
        );
        assert.equal(
          (yield* testFileSystem("inspect absolute symbolic link", () =>
            lstat(join(dir, "absolute-link.txt")),
          )).isSymbolicLink(),
          true,
        );
      }),
    ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
  );

  it.effect("resolves relative final links from their physical symlinked directory", () =>
    withTempDirectory("pi-code-preview-parent-link-", (dir) =>
      Effect.gen(function* () {
        const real = join(dir, "real");
        const nested = join(real, "sub");
        yield* testFileSystem("make fixture directory", () => mkdir(nested, { recursive: true }));
        yield* testFileSystem("write fixture", () => writeFile(join(real, "target.txt"), "before"));
        yield* testFileSystem("create parent symbolic link", () =>
          symlink("real/sub", join(dir, "alias")),
        );
        yield* testFileSystem("create leaf symbolic link", () =>
          symlink("../target.txt", join(nested, "leaf")),
        );

        yield* executeWriteWithPreviewEffect("tool-parent-link", "alias/leaf", "after", dir);

        assert.equal(
          yield* testFileSystem("read target", () => readFile(join(real, "target.txt"), "utf8")),
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
      }),
    ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
  );

  it.effect("writes preserve target inode, mode, hard-link aliases, and open descriptors", () =>
    withTempDirectory("pi-code-preview-inode-", (dir) =>
      Effect.gen(function* () {
        const target = join(dir, "target.txt");
        const alias = join(dir, "alias.txt");
        yield* testFileSystem("write fixture", () => writeFile(target, "before"));
        yield* testFileSystem("set fixture mode", () => chmod(target, 0o640));
        yield* testFileSystem("create hard link", () => createLink(target, alias));
        const before = yield* testFileSystem("inspect target", () => stat(target));
        yield* Effect.acquireUseRelease(
          testFileSystem("open target", () => open(target, "r")),
          (descriptor) =>
            Effect.gen(function* () {
              yield* executeWriteWithPreviewEffect("tool-inode", "target.txt", "after", dir);
              const after = yield* testFileSystem("inspect updated target", () => stat(target));
              const aliasAfter = yield* testFileSystem("inspect hard-link alias", () =>
                stat(alias),
              );
              const buffer = Buffer.alloc(5);
              const read = yield* testFileSystem("read open descriptor", () =>
                descriptor.read(buffer, 0, buffer.length, 0),
              );
              assert.equal(buffer.subarray(0, read.bytesRead).toString("utf8"), "after");
              assert.equal(
                yield* testFileSystem("read hard-link alias", () => readFile(alias, "utf8")),
                "after",
              );
              assert.equal(after.ino, before.ino);
              assert.equal(aliasAfter.ino, before.ino);
              assert.equal(after.mode & 0o777, 0o640);
            }),
          (descriptor) => testFileSystem("close target", () => descriptor.close()),
        );
      }),
    ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
  );

  it.effect("new files use normal writeFile creation mode under the process umask", () =>
    withTempDirectory("pi-code-preview-mode-", (dir) =>
      Effect.gen(function* () {
        const control = join(dir, "control.txt");
        const preview = join(dir, "preview.txt");
        yield* testFileSystem("write control fixture", () => writeFile(control, "control"));
        yield* executeWriteWithPreviewEffect("tool-mode", "preview.txt", "preview", dir);
        const controlMode =
          (yield* testFileSystem("inspect control fixture", () => stat(control))).mode & 0o777;
        const previewMode =
          (yield* testFileSystem("inspect preview fixture", () => stat(preview))).mode & 0o777;
        assert.equal(previewMode, controlMode);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
  );

  it.effect("dangling symlinks do not create target directories", () =>
    withTempDirectory("pi-code-preview-dangling-", (dir) =>
      Effect.gen(function* () {
        const link = join(dir, "link.txt");
        const missingDirectory = join(dir, "missing");
        yield* testFileSystem("create dangling symbolic link", () =>
          symlink("missing/target.txt", link),
        );
        const error = yield* Effect.flip(
          executeWriteWithPreviewEffect("tool-dangling", "link.txt", "after", dir),
        );
        assert.equal("operation" in error, true);
        if (!("operation" in error)) return;
        assert.equal(error.operation, "write");
        assert.equal(
          (yield* testFileSystem("inspect dangling symbolic link", () =>
            lstat(link),
          )).isSymbolicLink(),
          true,
        );
        const created = yield* Effect.promise(() =>
          lstat(missingDirectory).then(
            () => true,
            () => false,
          ),
        );
        assert.equal(created, false);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
  );

  it.effect("cyclic and over-depth final symlink chains fail without replacing links", () =>
    withTempDirectory("pi-code-preview-cycle-", (dir) =>
      Effect.gen(function* () {
        yield* testFileSystem("create first cyclic symbolic link", () =>
          symlink("b.txt", join(dir, "a.txt")),
        );
        yield* testFileSystem("create second cyclic symbolic link", () =>
          symlink("a.txt", join(dir, "b.txt")),
        );
        yield* Effect.flip(executeWriteWithPreviewEffect("tool-cycle", "a.txt", "after", dir));
        assert.equal(
          (yield* testFileSystem("inspect first cyclic symbolic link", () =>
            lstat(join(dir, "a.txt")),
          )).isSymbolicLink(),
          true,
        );
        assert.equal(
          (yield* testFileSystem("inspect second cyclic symbolic link", () =>
            lstat(join(dir, "b.txt")),
          )).isSymbolicLink(),
          true,
        );

        yield* testFileSystem("write deep-link target", () =>
          writeFile(join(dir, "deep-target.txt"), "before"),
        );
        for (let index = 0; index <= 40; index++) {
          const destination = index === 40 ? "deep-target.txt" : `deep-${index + 1}.txt`;
          yield* testFileSystem("create deep symbolic link", () =>
            symlink(destination, join(dir, `deep-${index}.txt`)),
          );
        }
        yield* Effect.flip(executeWriteWithPreviewEffect("tool-deep", "deep-0.txt", "after", dir));
        assert.equal(
          yield* testFileSystem("read deep-link target", () =>
            readFile(join(dir, "deep-target.txt"), "utf8"),
          ),
          "before",
        );
        assert.equal(
          (yield* testFileSystem("inspect first deep symbolic link", () =>
            lstat(join(dir, "deep-0.txt")),
          )).isSymbolicLink(),
          true,
        );
      }),
    ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
  );

  it.effect("interruption keeps the path semaphore until an uninterruptible write settles", () =>
    withTempDirectory("pi-code-preview-write-", (dir) =>
      Effect.gen(function* () {
        yield* testFileSystem("write fixture", () => writeFile(join(dir, "target.txt"), "before"));
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
        const first = yield* executeWriteWithPreviewEffect(
          "tool-1",
          "target.txt",
          "first",
          dir,
        ).pipe(Effect.provide(providers), Effect.forkScoped);
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
          yield* testFileSystem("read final target", () =>
            readFile(join(dir, "target.txt"), "utf8"),
          ),
          "second",
        );
        assert.deepEqual(lookupBeforeWrite("tool-1"), { kind: "content", content: "before" });
        assert.deepEqual(lookupBeforeWrite("tool-2"), { kind: "content", content: "first" });
      }).pipe(Effect.scoped),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
