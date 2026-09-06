// Node O_NOFOLLOW and inode checks have no equivalent in Effect FileSystem.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { nodeFsConstants as constants, nodeFsPromises as fs } from "./node-builtins.ts";
import { isStrictlyInsidePath } from "./paths.ts";

class SafeFileError extends Schema.TaggedError<SafeFileError>()("SafeFileError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface SafeFileResult {
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

interface FileHandleWithClose {
  readonly close: () => Promise<void>;
}

const safeFileError = (operation: string, message: string) => () =>
  new SafeFileError({ operation, message });

const nodePromise = <Value>(
  operation: string,
  message: string,
  evaluate: () => PromiseLike<Value>,
): Effect.Effect<Value, SafeFileError> =>
  Effect.tryPromise({ try: evaluate, catch: safeFileError(operation, message) });

const failRead = () =>
  Effect.fail(
    new SafeFileError({
      operation: "read",
      message: "Unable to read a stable contained regular file.",
    }),
  );

/** Internal Promise adapter kept exported for focused typed-error regression coverage. */
export const closeSafeFileHandle = (
  handle: FileHandleWithClose,
): Effect.Effect<void, SafeFileError> =>
  nodePromise("close", "Unable to close a stable regular file.", () => handle.close());

const readContainedRegularFile = Effect.fn("SafeFile.readContainedRegularFile")(function* (
  path: string,
  containmentRoot: string,
  maximumBytes: number,
) {
  const paths = yield* Path.Path;
  const maximumSize = yield* Effect.try({
    try: () => BigInt(maximumBytes),
    catch: safeFileError("size", "Unable to open a stable regular file."),
  });
  const before = yield* nodePromise("open", "Unable to open a stable regular file.", () =>
    fs.lstat(path, { bigint: true }),
  );
  if (!before.isFile())
    return yield* new SafeFileError({
      operation: "open",
      message: "Unable to open a stable regular file.",
    });
  if (before.size > maximumSize)
    return yield* new SafeFileError({
      operation: "size",
      message: "Unable to open a stable regular file.",
    });

  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  return yield* Effect.acquireUseRelease(
    nodePromise("open", "Unable to open a stable regular file.", () =>
      fs.open(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow),
    ),
    (handle) =>
      Effect.gen(function* () {
        const opened = yield* nodePromise(
          "read",
          "Unable to read a stable contained regular file.",
          () => handle.stat({ bigint: true }),
        );
        if (
          !opened.isFile() ||
          opened.size > maximumSize ||
          before.dev !== opened.dev ||
          before.ino !== opened.ino
        )
          return yield* failRead();

        const [resolvedPath, resolvedRoot] = yield* Effect.all(
          [
            nodePromise("read", "Unable to read a stable contained regular file.", () =>
              fs.realpath(path),
            ),
            nodePromise("read", "Unable to read a stable contained regular file.", () =>
              fs.realpath(containmentRoot),
            ),
          ] as const,
          { concurrency: 2 },
        );
        if (
          paths.resolve(resolvedRoot) !== paths.resolve(containmentRoot) ||
          !isStrictlyInsidePath(resolvedRoot, resolvedPath)
        )
          return yield* failRead();

        const visible = yield* nodePromise(
          "read",
          "Unable to read a stable contained regular file.",
          () => fs.stat(resolvedPath, { bigint: true }),
        );
        if (!visible.isFile() || visible.dev !== opened.dev || visible.ino !== opened.ino)
          return yield* failRead();

        const bytes = yield* nodePromise(
          "read",
          "Unable to read a stable contained regular file.",
          () => handle.readFile(),
        );
        const after = yield* nodePromise(
          "read",
          "Unable to read a stable contained regular file.",
          () => handle.stat({ bigint: true }),
        );
        if (
          after.dev !== opened.dev ||
          after.ino !== opened.ino ||
          after.size !== opened.size ||
          bytes.byteLength !== Number(opened.size) ||
          bytes.byteLength > maximumBytes
        )
          return yield* failRead();
        return { path: resolvedPath, bytes: new Uint8Array(bytes) } satisfies SafeFileResult;
      }),
    (handle) => closeSafeFileHandle(handle).pipe(Effect.ignore),
  );
});

/** Node-specific stable file acquisition for security-sensitive image inputs. */
export class SafeFile extends Context.Service<SafeFile, SafeFileContract>()(
  "pi-cosmic-core/platform/safe-file/SafeFile",
) {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const paths = yield* Path.Path;
      return SafeFile.of({
        readContainedRegularFile: (path, containmentRoot, maximumBytes) =>
          readContainedRegularFile(path, containmentRoot, maximumBytes).pipe(
            Effect.provideService(Path.Path, paths),
          ),
      });
    }).pipe(Effect.withSpan("pi-cosmic-core.safe-file.initialize")),
  );
}
