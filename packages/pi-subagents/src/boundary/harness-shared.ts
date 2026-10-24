import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { hasControlCharacter } from "pi-cosmic-core/security";
import { hasObjectRuntimeType } from "pi-cosmic-core/runtime-values";
import { nodeFsPromises as fs, nodePath } from "pi-cosmic-core/platform/node-builtins";
import { PrivateFileError, tryPrivateFileOperation } from "pi-cosmic-core/platform/private-file";

const MAX_PATH_CHARS = 4_096;

export const nodeErrorCode = (cause: unknown): string | undefined =>
  cause && hasObjectRuntimeType(cause) && "code" in cause && Predicate.isString(cause.code)
    ? cause.code
    : undefined;

const unsafeEntry = () => PrivateFileError.make({ reason: "unsafe" });

const isRealDirectory = (path: string): Effect.Effect<boolean, PrivateFileError> =>
  tryPrivateFileOperation(() => fs.lstat(path)).pipe(
    Effect.map((stat) => stat.isDirectory() && !stat.isSymbolicLink()),
  );

/** The canonical path of an absolute agent directory that is a real directory, never a link. */
export const safeAgentDirectory = Effect.fn("HarnessShared.safeAgentDirectory")(function* (
  agentDirectory: string,
): Effect.fn.Return<string, PrivateFileError> {
  if (
    !nodePath.isAbsolute(agentDirectory) ||
    agentDirectory.length > MAX_PATH_CHARS ||
    hasControlCharacter(agentDirectory)
  )
    return yield* unsafeEntry();
  const requested = nodePath.resolve(agentDirectory);
  if (!(yield* isRealDirectory(requested))) return yield* unsafeEntry();
  const canonical = yield* tryPrivateFileOperation(() => fs.realpath(requested));
  if (!(yield* isRealDirectory(canonical))) return yield* unsafeEntry();
  return canonical;
});
