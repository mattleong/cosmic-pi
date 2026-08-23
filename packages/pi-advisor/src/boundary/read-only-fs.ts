// Node filesystem access is confined to this capability-narrow read-only adapter whose
// contract (O_NOFOLLOW opens and inode identity checks) the Effect FileSystem cannot express.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { isContainedPath, isContainedPathWith } from "pi-cosmic-core";

export { isContainedPath, isContainedPathWith };

const nodeFsModule = process.getBuiltinModule("node:fs");
const nodePathModule = process.getBuiltinModule("node:path");
if (!nodeFsModule || !nodePathModule) throw new Error("Node fs/path builtins are unavailable.");
const { constants, promises: fs } = nodeFsModule;
const { resolve } = nodePathModule;

export class AdvisorFileError extends Schema.TaggedError<AdvisorFileError>()("AdvisorFileError", {
  operation: Schema.String,
  path: Schema.String,
  message: Schema.String,
}) {}
export interface ReadOnlyInfo {
  readonly type: "file" | "directory" | "symlink" | "other";
  readonly size: number;
  readonly dev: bigint;
  readonly ino: bigint;
}
export interface AdvisorProjectRoot {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}
export interface ReadOnlyEntry {
  readonly name: string;
  readonly type: ReadOnlyInfo["type"];
}
export interface ReadOnlyFileSystemContract {
  readonly pinRoot: (path: string) => Effect.Effect<AdvisorProjectRoot, AdvisorFileError>;
  readonly realPath: (path: string) => Effect.Effect<string, AdvisorFileError>;
  readonly lstat: (path: string) => Effect.Effect<ReadOnlyInfo, AdvisorFileError>;
  readonly stat: (path: string) => Effect.Effect<ReadOnlyInfo, AdvisorFileError>;
  readonly readDirectory: (
    path: string,
    root: AdvisorProjectRoot,
    maximum: number,
  ) => Effect.Effect<{ entries: ReadOnlyEntry[]; truncated: boolean }, AdvisorFileError>;
  readonly readBounded: (
    path: string,
    root: AdvisorProjectRoot,
    maximum: number,
  ) => Effect.Effect<{ bytes: Uint8Array; truncated: boolean }, AdvisorFileError>;
}
const kind = (value: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): ReadOnlyInfo["type"] =>
  value.isFile()
    ? "file"
    : value.isDirectory()
      ? "directory"
      : value.isSymbolicLink()
        ? "symlink"
        : "other";
const info = (value: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number | bigint;
  dev: number | bigint;
  ino: number | bigint;
}): ReadOnlyInfo => ({
  type: kind(value),
  size: Number(value.size),
  dev: BigInt(value.dev),
  ino: BigInt(value.ino),
});
const failure = (operation: string, path: string, message: string) => () =>
  new AdvisorFileError({ operation, path, message });

type CloseOperation = "close-directory" | "close-file";

const closeResource = (operation: CloseOperation, path: string, close: () => Promise<void>) =>
  Effect.tryPromise({
    try: () => close(),
    catch: failure(
      operation,
      path,
      operation === "close-directory"
        ? "Unable to close project directory."
        : "Unable to close project file.",
    ),
  });

const closeResourceBestEffort = (
  operation: CloseOperation,
  path: string,
  close: () => Promise<void>,
) => closeResource(operation, path, close).pipe(Effect.ignore);

let beforeDirectoryOpenHook: ((path: string) => void | Promise<void>) | undefined;
let afterDirectoryReadHook: ((path: string) => void | Promise<void>) | undefined;

const sameIdentity = (
  expected: { readonly dev: bigint; readonly ino: bigint },
  actual: { readonly dev: bigint; readonly ino: bigint },
): boolean => expected.dev === actual.dev && expected.ino === actual.ino;

const verifyPinnedRoot = (root: AdvisorProjectRoot) =>
  Effect.tryPromise({
    try: () =>
      fs.lstat(root.path, { bigint: true }).then((visible) => {
        if (
          !visible.isDirectory() ||
          visible.isSymbolicLink() ||
          !sameIdentity(root, info(visible))
        ) {
          throw new Error("project root identity changed");
        }
      }),
    catch: failure("verify-root", root.path, "Project root identity changed."),
  });

export class ReadOnlyFileSystem extends Context.Service<
  ReadOnlyFileSystem,
  ReadOnlyFileSystemContract
>()("pi-advisor/boundary/read-only-fs/ReadOnlyFileSystem") {
  static readonly layer = Layer.succeed(
    this,
    this.of({
      pinRoot: (path) =>
        Effect.tryPromise({
          try: () =>
            fs.realpath(path).then((canonical) =>
              fs.lstat(canonical, { bigint: true }).then((value) => {
                if (!value.isDirectory() || value.isSymbolicLink())
                  throw new Error("not directory");
                return { path: canonical, dev: BigInt(value.dev), ino: BigInt(value.ino) };
              }),
            ),
          catch: failure("pin-root", path, "Unable to pin project root."),
        }),
      realPath: (path) =>
        Effect.tryPromise({
          try: () => fs.realpath(path),
          catch: failure("realpath", path, "Unable to resolve path."),
        }),
      lstat: (path) =>
        Effect.tryPromise({
          try: () => fs.lstat(path, { bigint: true }).then(info),
          catch: failure("lstat", path, "Unable to inspect path."),
        }),
      stat: (path) =>
        Effect.tryPromise({
          try: () => fs.stat(path, { bigint: true }).then(info),
          catch: failure("stat", path, "Unable to inspect path."),
        }),
      readDirectory: (path, root, maximum) =>
        Effect.gen(function* () {
          yield* verifyPinnedRoot(root);
          const prepared = yield* Effect.tryPromise({
            try: () =>
              fs.realpath(path).then((beforePath) => {
                if (!isContainedPath(root.path, beforePath)) throw new Error("outside root");
                return fs.lstat(beforePath, { bigint: true }).then((before) => {
                  if (!before.isDirectory() || before.isSymbolicLink())
                    throw new Error("not directory");
                  return { before: info(before), beforePath };
                });
              }),
            catch: failure("prepare-directory", path, "Unable to open stable project directory."),
          });
          const listing = yield* Effect.acquireUseRelease(
            Effect.tryPromise({
              try: () =>
                Promise.resolve(beforeDirectoryOpenHook?.(prepared.beforePath)).then(() =>
                  fs.opendir(prepared.beforePath),
                ),
              catch: failure("open-directory", path, "Unable to open project directory."),
            }),
            (directory) =>
              Effect.tryPromise({
                try: () => {
                  const entries: ReadOnlyEntry[] = [];
                  const next = (): Promise<{ entries: ReadOnlyEntry[]; truncated: boolean }> =>
                    directory.read().then((entry) => {
                      if (!entry) return { entries, truncated: false };
                      if (entries.length >= maximum) return { entries, truncated: true };
                      entries.push({ name: entry.name, type: kind(entry) });
                      return next();
                    });
                  return next();
                },
                catch: failure("read-directory", path, "Unable to read project directory."),
              }),
            (directory) =>
              closeResourceBestEffort("close-directory", path, () => directory.close()),
          );
          yield* verifyPinnedRoot(root);
          yield* Effect.tryPromise({
            try: () => Promise.resolve(afterDirectoryReadHook?.(prepared.beforePath)),
            catch: failure("directory-hook", path, "Project directory changed during scan."),
          });
          const verifyDirectory = Effect.tryPromise({
            try: () =>
              Promise.all([
                fs.realpath(path),
                fs.lstat(prepared.beforePath, { bigint: true }),
              ]).then(([visiblePath, visible]) => {
                const identity = info(visible);
                if (
                  visiblePath !== prepared.beforePath ||
                  !isContainedPath(root.path, visiblePath) ||
                  identity.type !== "directory" ||
                  !sameIdentity(prepared.before, identity)
                )
                  throw new Error("directory identity changed");
              }),
            catch: failure("verify-directory", path, "Project directory changed during scan."),
          });
          yield* verifyDirectory;
          const validated: ReadOnlyEntry[] = [];
          let rejected = false;
          for (const raw of listing.entries) {
            const candidate = resolve(prepared.beforePath, raw.name);
            if (!isContainedPath(prepared.beforePath, candidate)) {
              rejected = true;
              continue;
            }
            const current = yield* Effect.tryPromise({
              try: () =>
                fs.lstat(candidate, { bigint: true }).then((visible) => {
                  const currentInfo = info(visible);
                  if (currentInfo.type === "symlink") return currentInfo;
                  return fs.realpath(candidate).then((canonical) => {
                    if (!isContainedPath(root.path, canonical)) throw new Error("outside root");
                    return currentInfo;
                  });
                }),
              catch: failure("verify-entry", candidate, "Project entry changed during scan."),
            }).pipe(Effect.catch(() => Effect.void));
            yield* verifyPinnedRoot(root);
            yield* verifyDirectory;
            if (!current) {
              rejected = true;
              continue;
            }
            validated.push({ name: raw.name, type: current.type });
          }
          return { entries: validated, truncated: listing.truncated || rejected };
        }),
      readBounded: (path, root, maximum) =>
        Effect.gen(function* () {
          yield* verifyPinnedRoot(root);
          const opened = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () =>
                fs.realpath(path).then((beforePath) => {
                  if (!isContainedPath(root.path, beforePath) || beforePath === root.path)
                    throw new Error("outside root");
                  return fs.lstat(beforePath, { bigint: true }).then((before) => {
                    if (!before.isFile() || before.isSymbolicLink()) throw new Error("not file");
                    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
                    return fs
                      .open(beforePath, constants.O_RDONLY | constants.O_NONBLOCK | noFollow)
                      .then((handle) => ({ before: info(before), beforePath, handle }));
                  });
                }),
              catch: failure("open", path, "Unable to open stable project file."),
            }),
            ({ handle }) => closeResourceBestEffort("close-file", path, () => handle.close()),
          );
          const verifyVisible = Effect.tryPromise({
            try: () =>
              Promise.all([opened.handle.stat({ bigint: true }), fs.realpath(path)]).then(
                ([handleInfo, visiblePath]) =>
                  fs.lstat(visiblePath, { bigint: true }).then((visibleInfo) => {
                    const descriptor = info(handleInfo);
                    const visible = info(visibleInfo);
                    if (
                      descriptor.type !== "file" ||
                      visible.type !== "file" ||
                      visiblePath !== opened.beforePath ||
                      !isContainedPath(root.path, visiblePath) ||
                      !sameIdentity(opened.before, descriptor) ||
                      !sameIdentity(descriptor, visible)
                    )
                      throw new Error("file identity changed");
                  }),
              ),
            catch: failure("verify-file", path, "Project file changed during read."),
          });
          yield* verifyVisible;
          const allocation = Buffer.allocUnsafe(maximum + 1);
          const result = yield* Effect.tryPromise({
            try: () => opened.handle.read(allocation, 0, allocation.length, 0),
            catch: failure("read", path, "Unable to read stable project file."),
          });
          yield* verifyPinnedRoot(root);
          yield* verifyVisible;
          return {
            bytes: new Uint8Array(allocation.subarray(0, Math.min(result.bytesRead, maximum))),
            truncated: result.bytesRead > maximum,
          };
        }).pipe(Effect.scoped),
    }),
  );
}

export const _readOnlyFileSystemTest = {
  closeResource,
  closeResourceBestEffort,
  isContainedPath,
  isContainedPathWith,
  setDirectoryHooks(hooks?: {
    beforeOpen?: (path: string) => void | Promise<void>;
    afterRead?: (path: string) => void | Promise<void>;
  }) {
    beforeDirectoryOpenHook = hooks?.beforeOpen;
    afterDirectoryReadHook = hooks?.afterRead;
  },
};
