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

const READ_FAILURE = "Unable to read a stable contained regular file.";
const OPEN_FAILURE = "Unable to open a stable regular file.";

const safeFileError = (operation: string, message: string) => () =>
  new SafeFileError({ operation, message });

const nodePromise = <Value>(
  operation: string,
  message: string,
  evaluate: () => PromiseLike<Value>,
): Effect.Effect<Value, SafeFileError> =>
  Effect.tryPromise({ try: evaluate, catch: safeFileError(operation, message) });

const readStep = <Value>(evaluate: () => PromiseLike<Value>) =>
  nodePromise("read", READ_FAILURE, evaluate);
const failRead = () => Effect.fail(safeFileError("read", READ_FAILURE)());

const readContainedRegularFile = Effect.fn("SafeFile.readContainedRegularFile")(function* (
  path: string,
  containmentRoot: string,
  maximumBytes: number,
) {
  const paths = yield* Path.Path;
  const maximumSize = yield* Effect.try({
    try: () => BigInt(maximumBytes),
    catch: safeFileError("size", OPEN_FAILURE),
  });
  const before = yield* nodePromise("open", OPEN_FAILURE, () => fs.lstat(path, { bigint: true }));
  if (!before.isFile()) return yield* safeFileError("open", OPEN_FAILURE)();
  if (before.size > maximumSize) return yield* safeFileError("size", OPEN_FAILURE)();

  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  return yield* Effect.acquireUseRelease(
    nodePromise("open", OPEN_FAILURE, () =>
      fs.open(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow),
    ),
    (handle) =>
      Effect.gen(function* () {
        const opened = yield* readStep(() => handle.stat({ bigint: true }));
        if (
          !opened.isFile() ||
          opened.size > maximumSize ||
          before.dev !== opened.dev ||
          before.ino !== opened.ino
        )
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
        if (!visible.isFile() || visible.dev !== opened.dev || visible.ino !== opened.ino)
          return yield* failRead();

        const bytes = yield* readStep(() => handle.readFile());
        const after = yield* readStep(() => handle.stat({ bigint: true }));
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
    (handle) =>
      nodePromise("close", "Unable to close a stable regular file.", () => handle.close()).pipe(
        Effect.ignore,
      ),
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
