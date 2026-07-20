// Node O_NOFOLLOW and inode checks have no equivalent in Effect FileSystem.
// @effect-diagnostics effect/nodeBuiltinImport:off
import { constants, promises as fs } from "node:fs";
import * as nodePath from "node:path";
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

export interface SafeFileShape {
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

/** Node-specific stable file acquisition for security-sensitive image inputs. */
export class SafeFile extends Context.Service<SafeFile, SafeFileShape>()(
  "pi-cosmic-core/platform/safe-file/SafeFile",
) {
  static readonly layer = Layer.effect(
    this,
    Effect.sync(() =>
      this.of({
        readContainedRegularFile: (path, containmentRoot, maximumBytes) =>
          Effect.acquireUseRelease(
            Effect.tryPromise({
              try: () =>
                fs.lstat(path, { bigint: true }).then((before) => {
                  if (!before.isFile()) return Promise.reject("not-regular");
                  if (before.size > BigInt(maximumBytes)) return Promise.reject("too-large");
                  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
                  return fs
                    .open(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow)
                    .then((handle) => ({ before, handle }));
                }),
              catch: (error) =>
                new SafeFileError({
                  operation: error === "too-large" ? "size" : "open",
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
                      return Promise.reject("identity");
                    return Promise.all([fs.realpath(path), fs.realpath(containmentRoot)]).then(
                      ([resolvedPath, resolvedRoot]) => {
                        if (
                          nodePath.resolve(resolvedRoot) !== nodePath.resolve(containmentRoot) ||
                          !isStrictlyInside(resolvedRoot, resolvedPath)
                        )
                          return Promise.reject("containment");
                        return fs.stat(resolvedPath, { bigint: true }).then((visible) => {
                          if (
                            !visible.isFile() ||
                            visible.dev !== opened.dev ||
                            visible.ino !== opened.ino
                          )
                            return Promise.reject("visible-identity");
                          return handle.readFile().then((bytes) =>
                            handle.stat({ bigint: true }).then((after) => {
                              if (
                                after.dev !== opened.dev ||
                                after.ino !== opened.ino ||
                                after.size !== opened.size ||
                                bytes.byteLength !== Number(opened.size) ||
                                bytes.byteLength > maximumBytes
                              )
                                return Promise.reject("changed");
                              return {
                                path: resolvedPath,
                                bytes: new Uint8Array(bytes),
                              } satisfies SafeFileResult;
                            }),
                          );
                        });
                      },
                    );
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
    ).pipe(Effect.withSpan("pi-cosmic-core.safe-file.initialize")),
  );
}
