import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { nodeFsConstants as constants, nodeFsPromises as fs } from "./node-builtins.ts";
import { isStrictlyInsidePath } from "./paths.ts";

class SafeFileError extends Schema.TaggedError<SafeFileError, { readonly brand: unique symbol }>()(
  "SafeFileError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

interface SafeFileResult {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface SafeFileContract {
  readonly readContainedRegularFile: (
    path: string,
    containmentRoot: string,
    maximumBytes: number,
  ) => Effect.Effect<SafeFileResult, SafeFileError>;
}

const READ_FAILURE = "Unable to read a stable contained regular file.";
const OPEN_FAILURE = "Unable to open a stable regular file.";

const safeFileError = (operation: string, message: string) => () =>
  SafeFileError.make({ operation, message });

const nodePromise = <Value>(
  operation: string,
  message: string,
  evaluate: () => PromiseLike<Value>,
): Effect.Effect<Value, SafeFileError> =>
  Effect.tryPromise({ try: evaluate, catch: safeFileError(operation, message) });

const readStep = <Value>(evaluate: () => PromiseLike<Value>) =>
  nodePromise("read", READ_FAILURE, evaluate);
const failRead = () => Effect.fail(safeFileError("read", READ_FAILURE)());

type OpenedFile = Awaited<ReturnType<typeof fs.open>>;

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

const sameFile = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const readExactly = Effect.fnUntraced(function* (handle: OpenedFile, size: bigint) {
  const bytes = yield* Effect.try({
    try: () => new Uint8Array(Number(size)),
    catch: safeFileError("read", READ_FAILURE),
  });
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = yield* readStep(() =>
      handle.read({
        buffer: bytes,
        offset,
        length: bytes.byteLength - offset,
        position: offset,
      }),
    );
    if (bytesRead === 0) return yield* failRead();
    offset += bytesRead;
  }
  const extra = yield* readStep(() =>
    handle.read({ buffer: new Uint8Array(1), position: bytes.byteLength }),
  );
  if (extra.bytesRead !== 0) return yield* failRead();
  return bytes;
});

const readContainedRegularFile = (paths: Path.Path) =>
  Effect.fn("SafeFile.readContainedRegularFile")(function* (
    path: string,
    containmentRoot: string,
    maximumBytes: number,
  ) {
    const maximumSize = yield* Effect.try({
      try: () => BigInt(maximumBytes),
      catch: safeFileError("size", OPEN_FAILURE),
    });
    const before = yield* nodePromise("open", OPEN_FAILURE, () => fs.lstat(path, { bigint: true }));
    if (!before.isFile()) return yield* safeFileError("open", OPEN_FAILURE)();
    if (before.size > maximumSize) return yield* safeFileError("size", OPEN_FAILURE)();

    return yield* Effect.acquireUseRelease(
      nodePromise("open", OPEN_FAILURE, () =>
        fs.open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW),
      ),
      (handle) =>
        Effect.gen(function* () {
          const opened = yield* readStep(() => handle.stat({ bigint: true }));
          if (!opened.isFile() || opened.size > maximumSize || !sameFile(before, opened))
            return yield* failRead();

          const [resolvedPath, resolvedRoot] = yield* Effect.all(
            [
              readStep(() => fs.realpath(path)),
              readStep(() => fs.realpath(containmentRoot)),
            ] as const,
            { concurrency: 2 },
          );
          if (
            paths.resolve(resolvedRoot) !== paths.resolve(containmentRoot) ||
            !isStrictlyInsidePath(resolvedRoot, resolvedPath)
          )
            return yield* failRead();

          const visible = yield* readStep(() => fs.stat(resolvedPath, { bigint: true }));
          if (!visible.isFile() || !sameFile(visible, opened)) return yield* failRead();

          const bytes = yield* readExactly(handle, opened.size);
          const after = yield* readStep(() => handle.stat({ bigint: true }));
          if (
            !sameFile(after, opened) ||
            after.size !== opened.size ||
            after.mtimeNs !== opened.mtimeNs ||
            after.ctimeNs !== opened.ctimeNs
          )
            return yield* failRead();
          return { path: resolvedPath, bytes } satisfies SafeFileResult;
        }),
      (handle) =>
        nodePromise("close", "Unable to close a stable regular file.", () => handle.close()).pipe(
          Effect.ignore,
        ),
    );
  });

export class SafeFile extends Context.Service<SafeFile, SafeFileContract>()(
  "pi-cosmic-core/platform/safe-file/SafeFile",
) {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      return SafeFile.of({ readContainedRegularFile: readContainedRegularFile(yield* Path.Path) });
    }).pipe(Effect.withSpan("pi-cosmic-core.safe-file.initialize")),
  );
}
