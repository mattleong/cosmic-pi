const nodeFs = process.getBuiltinModule("node:fs");
const nodePath = process.getBuiltinModule("node:path");
if (!nodeFs || !nodePath) throw new Error("Node filesystem APIs are unavailable.");
const { constants } = nodeFs;
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class SafeFileError extends Schema.TaggedErrorClass<SafeFileError>()("SafeFileError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface SafeFileResult {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface SafeFileAdapterShape {
  /** Open without following the final symlink, then verify identity and containment before reading. */
  readonly readContainedRegularFile: (
    path: string,
    containmentRoot: string,
    maximumBytes: number,
  ) => Effect.Effect<SafeFileResult, SafeFileError>;
}

const isStrictlyInside = (root: string, candidate: string): boolean => {
  const relative = nodePath.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${nodePath.sep}`) &&
    !nodePath.isAbsolute(relative)
  );
};

export class SafeFileAdapter extends Context.Service<SafeFileAdapter, SafeFileAdapterShape>()(
  "pi-better-openai/boundary/safe-file/SafeFileAdapter",
) {
  static readonly layer = Layer.succeed(
    this,
    this.of({
      readContainedRegularFile: (path, containmentRoot, maximumBytes) =>
        Effect.acquireUseRelease(
          Effect.tryPromise({
            try: () =>
              nodeFs.promises.lstat(path, { bigint: true }).then((before) => {
                if (!before.isFile()) throw new Error("not a regular file");
                if (before.size > BigInt(maximumBytes)) throw new Error("file is too large");
                const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
                return nodeFs.promises
                  .open(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow)
                  .then((handle) => ({ before, handle }));
              }),
            catch: (error) =>
              new SafeFileError({
                operation:
                  error instanceof Error && error.message === "file is too large" ? "size" : "open",
                message: "Unable to open a stable regular file.",
              }),
          }),
          ({ before, handle }) =>
            Effect.tryPromise({
              try: () =>
                handle.stat({ bigint: true }).then((opened) => {
                  if (
                    !opened.isFile() ||
                    opened.size > BigInt(maximumBytes) ||
                    before.dev !== opened.dev ||
                    before.ino !== opened.ino
                  )
                    throw new Error("file identity changed");

                  // Re-resolve only after the stable handle is open. If an ancestor was
                  // replaced between the caller's initial check and open(), this resolves
                  // outside the trusted root and fails before any bytes are read.
                  return Promise.all([
                    nodeFs.promises.realpath(path),
                    nodeFs.promises.realpath(containmentRoot),
                  ]).then(([resolvedPath, resolvedRoot]) => {
                    if (
                      nodePath.resolve(resolvedRoot) !== nodePath.resolve(containmentRoot) ||
                      !isStrictlyInside(resolvedRoot, resolvedPath)
                    )
                      throw new Error("file escaped containment root");
                    return nodeFs.promises.stat(resolvedPath, { bigint: true }).then((visible) => {
                      if (
                        !visible.isFile() ||
                        visible.dev !== opened.dev ||
                        visible.ino !== opened.ino
                      )
                        throw new Error("visible file identity changed");
                      return handle.readFile().then((bytes) =>
                        handle.stat({ bigint: true }).then((after) => {
                          if (
                            after.dev !== opened.dev ||
                            after.ino !== opened.ino ||
                            after.size !== opened.size ||
                            bytes.byteLength !== Number(opened.size) ||
                            bytes.byteLength > maximumBytes
                          )
                            throw new Error("file changed while reading");
                          return {
                            path: resolvedPath,
                            bytes: new Uint8Array(bytes),
                          } satisfies SafeFileResult;
                        }),
                      );
                    });
                  });
                }),
              catch: () =>
                new SafeFileError({
                  operation: "read",
                  message: "Unable to read a stable contained regular file.",
                }),
            }),
          ({ handle }) => Effect.promise(() => handle.close()).pipe(Effect.ignore),
        ),
    }),
  );
}
