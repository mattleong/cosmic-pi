// Raw lstat inspects symbolic links because Effect FileSystem.stat follows them.
import assert from "node:assert/strict";
import { layer } from "@effect/vitest";
import { createWriteTool } from "@earendil-works/pi-coding-agent";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { provideBuiltLayer } from "pi-cosmic-core";
import { executeWriteWithPreviewEffect } from "../../src/write/preview-execution";
import { lookupBeforeWrite } from "../../src/write/projection";
import { CodePreviewWriteService } from "../../src/write/service";

// Raw Node builtin access for test scaffolding, mirroring pi-cosmic-core's platform boundary.
const nodeFsModule = process.getBuiltinModule("node:fs");
const nodePathModule = process.getBuiltinModule("node:path");
if (!nodeFsModule || !nodePathModule) throw new Error("Node fs/path builtins are unavailable.");
const { lstat } = nodeFsModule.promises;
const { join } = nodePathModule;

const isSymlink = (path: string) =>
  Effect.promise(() => lstat(path).then((stats) => stats.isSymbolicLink()));

/** The shared FileSystem plus a temp directory removed when the test scope closes. */
const fixture = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return { fs, dir: yield* fs.makeTempDirectoryScoped({ prefix }) };
  });

/** The error text a write reports, the way Pi reads a rejected tool call. */
class NativeWriteFailure extends Data.TaggedError("NativeWriteFailure")<{
  readonly message: string;
}> {}

const writeOutcome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => (error instanceof Error ? error.message : String(error)),
      onSuccess: () => "written",
    }),
  );

const testLayer = Layer.mergeAll(
  CodePreviewWriteService.layer,
  NodeFileSystem.layer,
  NodePath.layer,
);

layer(testLayer)("session write service", (it) => {
  it.effect("reads the previous file Pi writes under a working directory with Unicode spaces", () =>
    Effect.gen(function* () {
      const { fs, dir } = yield* fixture("pi-code-preview-unicode-");
      // Pi normalizes Unicode spaces in the tool path, never in the working directory.
      const cwd = join(dir, "project\u3000a");
      yield* fs.makeDirectory(cwd);
      yield* fs.writeFileString(join(cwd, "file.txt"), "before");
      const result = yield* executeWriteWithPreviewEffect("tool-unicode", "file.txt", "after", cwd);
      assert.deepEqual(lookupBeforeWrite("tool-unicode"), { kind: "content", content: "before" });
      assert.deepEqual(result.details.codePreviewBeforeWrite, { kind: "content", byteLength: 6 });
      assert.equal(yield* fs.readFileString(join(cwd, "file.txt")), "after");
    }),
  );

  it.effect("writes follow mixed relative and absolute final symlink chains", () =>
    Effect.gen(function* () {
      const { fs, dir } = yield* fixture("pi-code-preview-chain-");
      const target = join(dir, "target.txt");
      yield* fs.writeFileString(target, "before");
      yield* fs.symlink(target, join(dir, "absolute-link.txt"));
      yield* fs.symlink("absolute-link.txt", join(dir, "relative-link.txt"));
      yield* executeWriteWithPreviewEffect("tool-chain", "relative-link.txt", "after", dir);
      assert.equal(yield* fs.readFileString(target), "after");
      assert.equal(yield* isSymlink(join(dir, "relative-link.txt")), true);
      assert.equal(yield* isSymlink(join(dir, "absolute-link.txt")), true);
    }),
  );

  it.effect("resolves relative final links from their physical symlinked directory", () =>
    Effect.gen(function* () {
      const { fs, dir } = yield* fixture("pi-code-preview-parent-link-");
      const real = join(dir, "real");
      const nested = join(real, "sub");
      yield* fs.makeDirectory(nested, { recursive: true });
      yield* fs.writeFileString(join(real, "target.txt"), "before");
      yield* fs.symlink("real/sub", join(dir, "alias"));
      yield* fs.symlink("../target.txt", join(nested, "leaf"));

      yield* executeWriteWithPreviewEffect("tool-parent-link", "alias/leaf", "after", dir);

      assert.equal(yield* fs.readFileString(join(real, "target.txt")), "after");
      assert.equal(yield* fs.exists(join(dir, "target.txt")), false);
    }),
  );

  it.effect("writes preserve target inode, mode, hard-link aliases, and open descriptors", () =>
    Effect.gen(function* () {
      const { fs, dir } = yield* fixture("pi-code-preview-inode-");
      const target = join(dir, "target.txt");
      const alias = join(dir, "alias.txt");
      yield* fs.writeFileString(target, "before");
      yield* fs.chmod(target, 0o640);
      yield* fs.link(target, alias);
      const before = yield* fs.stat(target);
      const descriptor = yield* fs.open(target);
      yield* executeWriteWithPreviewEffect("tool-inode", "target.txt", "after", dir);
      const after = yield* fs.stat(target);
      const aliasAfter = yield* fs.stat(alias);
      const read = yield* descriptor.readAlloc(5);
      assert.equal(new TextDecoder().decode(Option.getOrThrow(read)), "after");
      assert.equal(yield* fs.readFileString(alias), "after");
      assert.equal(Option.getOrThrow(after.ino), Option.getOrThrow(before.ino));
      assert.equal(Option.getOrThrow(aliasAfter.ino), Option.getOrThrow(before.ino));
      assert.equal(after.mode & 0o777, 0o640);
    }),
  );

  it.effect("new files use normal writeFile creation mode under the process umask", () =>
    Effect.gen(function* () {
      const { fs, dir } = yield* fixture("pi-code-preview-mode-");
      const control = join(dir, "control.txt");
      yield* fs.writeFileString(control, "control");
      yield* executeWriteWithPreviewEffect("tool-mode", "preview.txt", "preview", dir);
      const controlMode = (yield* fs.stat(control)).mode & 0o777;
      const previewMode = (yield* fs.stat(join(dir, "preview.txt"))).mode & 0o777;
      assert.equal(previewMode, controlMode);
    }),
  );

  it.effect("dangling symlinks do not create target directories", () =>
    Effect.gen(function* () {
      const { fs, dir } = yield* fixture("pi-code-preview-dangling-");
      const link = join(dir, "link.txt");
      yield* fs.symlink("missing/target.txt", link);
      const error = yield* Effect.flip(
        executeWriteWithPreviewEffect("tool-dangling", "link.txt", "after", dir),
      );
      assert.ok(Predicate.isTagged(error, "CodePreviewWriteError"));
      assert.equal(yield* isSymlink(link), true);
      assert.equal(yield* fs.exists(join(dir, "missing")), false);
    }),
  );

  it.effect("failures report the same error text as Pi's own write", () =>
    Effect.gen(function* () {
      const { fs, dir } = yield* fixture("pi-code-preview-native-error-");
      yield* fs.writeFileString(join(dir, "read-only.txt"), "before");
      yield* fs.chmod(join(dir, "read-only.txt"), 0o444);
      yield* fs.makeDirectory(join(dir, "folder"));
      // A privileged runner may write the read-only file; the directory always fails.
      for (const path of ["read-only.txt", "folder"]) {
        const native = yield* writeOutcome(
          Effect.tryPromise({
            try: () =>
              createWriteTool(dir).execute("native", { path, content: "after" }, undefined),
            catch: (cause) =>
              new NativeWriteFailure({
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          }),
        );
        if (native === "written") yield* fs.writeFileString(join(dir, path), "before");
        const hooked = yield* writeOutcome(
          executeWriteWithPreviewEffect(`hooked-${path}`, path, "after", dir),
        );
        assert.equal(hooked, native);
      }
    }),
  );

  it.effect("cyclic and over-depth final symlink chains fail without replacing links", () =>
    Effect.gen(function* () {
      const { fs, dir } = yield* fixture("pi-code-preview-cycle-");
      yield* fs.symlink("b.txt", join(dir, "a.txt"));
      yield* fs.symlink("a.txt", join(dir, "b.txt"));
      yield* Effect.flip(executeWriteWithPreviewEffect("tool-cycle", "a.txt", "after", dir));
      assert.equal(yield* isSymlink(join(dir, "a.txt")), true);
      assert.equal(yield* isSymlink(join(dir, "b.txt")), true);

      yield* fs.writeFileString(join(dir, "deep-target.txt"), "before");
      for (let index = 0; index <= 40; index++) {
        const destination = index === 40 ? "deep-target.txt" : `deep-${index + 1}.txt`;
        yield* fs.symlink(destination, join(dir, `deep-${index}.txt`));
      }
      yield* Effect.flip(executeWriteWithPreviewEffect("tool-deep", "deep-0.txt", "after", dir));
      assert.equal(yield* fs.readFileString(join(dir, "deep-target.txt")), "before");
      assert.equal(yield* isSymlink(join(dir, "deep-0.txt")), true);
    }),
  );

  it.effect("captures before-state only after a native predecessor has committed", () =>
    Effect.gen(function* () {
      const { fs, dir } = yield* fixture("pi-code-preview-native-first-");
      const target = join(dir, "file");
      yield* fs.writeFileString(target, "original");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const run = Effect.runPromiseWith(yield* Effect.context<never>());
      const native = createWriteTool(dir, {
        operations: {
          mkdir: () => Promise.resolve(),
          writeFile: (path, content) =>
            run(
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(fs.writeFileString(path, content)),
              ),
            ),
        },
      });
      const predecessor = yield* Effect.promise(() =>
        native.execute("native-first", { path: "file", content: "native" }, undefined),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const preview = yield* executeWriteWithPreviewEffect(
        "preview-after-native",
        "file",
        "preview",
        dir,
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.equal(preview.pollUnsafe(), undefined);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(predecessor);
      yield* Fiber.join(preview);
      assert.deepEqual(lookupBeforeWrite("preview-after-native"), {
        kind: "content",
        content: "native",
      });
      assert.equal(yield* fs.readFileString(target), "preview");
    }).pipe(Effect.scoped),
  );

  it.effect("cancellation during mkdir settles the operation without admitting a write", () =>
    Effect.gen(function* () {
      const { fs, dir } = yield* fixture("pi-code-preview-mkdir-");
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let wrote = false;
      const delayed = FileSystem.FileSystem.of({
        ...fs,
        makeDirectory: (directory, options) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(fs.makeDirectory(directory, options)),
          ),
        writeFileString: (target, next, options) =>
          Effect.sync(() => {
            wrote = true;
          }).pipe(Effect.andThen(fs.writeFileString(target, next, options))),
      });
      const first = yield* executeWriteWithPreviewEffect(
        "mkdir-cancelled",
        "new/file",
        "stale",
        dir,
      ).pipe(Effect.provideService(FileSystem.FileSystem, delayed), Effect.forkScoped);
      yield* Deferred.await(started);
      const cancellation = yield* Fiber.interrupt(first).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.equal(cancellation.pollUnsafe(), undefined);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(cancellation);
      const result = yield* executeWriteWithPreviewEffect("mkdir-next", "new/file", "fresh", dir);
      assert.equal(wrote, false);
      assert.equal(lookupBeforeWrite("mkdir-cancelled"), undefined);
      assert.equal(result.details.codePreviewBeforeWrite, undefined);
      assert.equal(yield* fs.readFileString(join(dir, "new/file")), "fresh");
    }).pipe(Effect.scoped),
  );

  it.effect("cancellation during the queued before-state read cannot mutate the file", () =>
    Effect.gen(function* () {
      const { fs, dir } = yield* fixture("pi-code-preview-read-");
      const target = join(dir, "file");
      yield* fs.writeFileString(target, "before");
      const started = yield* Deferred.make<void>();
      const delayed = FileSystem.FileSystem.of({
        ...fs,
        open: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const first = yield* executeWriteWithPreviewEffect(
        "read-cancelled",
        "file",
        "stale",
        dir,
      ).pipe(Effect.provideService(FileSystem.FileSystem, delayed), Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(first);
      const next = yield* executeWriteWithPreviewEffect("read-next", "file", "fresh", dir);
      assert.deepEqual(lookupBeforeWrite("read-next"), { kind: "content", content: "before" });
      assert.equal(lookupBeforeWrite("read-cancelled"), undefined);
      assert.deepEqual(next.details.codePreviewBeforeWrite, { kind: "content", byteLength: 6 });
    }).pipe(Effect.scoped),
  );

  it.effect("interruption holds Pi's queue through mutation and correlation settlement", () =>
    Effect.gen(function* () {
      const { fs, dir } = yield* fixture("pi-code-preview-write-");
      yield* fs.writeFileString(join(dir, "target.txt"), "before");
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
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
        provideBuiltLayer(providers),
        Effect.forkScoped,
      );
      yield* Deferred.await(started);
      const second = yield* Effect.promise(() =>
        createWriteTool(dir).execute(
          "native-tool",
          { path: "target.txt", content: "second" },
          undefined,
        ),
      ).pipe(Effect.forkScoped);
      yield* Fiber.interrupt(first).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const pendingBeforeRelease = second.pollUnsafe();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(second);
      assert.equal(pendingBeforeRelease, undefined);
      assert.equal(yield* fs.readFileString(join(dir, "target.txt")), "second");
      assert.deepEqual(lookupBeforeWrite("tool-1"), { kind: "content", content: "before" });
      yield* executeWriteWithPreviewEffect("tool-2", "target.txt", "third", dir).pipe(
        provideBuiltLayer(providers),
      );
      assert.deepEqual(lookupBeforeWrite("tool-2"), { kind: "content", content: "second" });
    }).pipe(Effect.scoped),
  );
});
