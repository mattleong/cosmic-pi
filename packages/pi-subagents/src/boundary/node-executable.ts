import * as Effect from "effect/Effect";
import { invalidRequest } from "../run/errors.ts";
import { nodeErrorCode } from "pi-cosmic-core/platform/errors";
import { nodeFsConstants, nodeFsPromises } from "pi-cosmic-core/platform/node-builtins";
import { homeDisplayPath } from "../ui/display-path.ts";

/**
 * Why the Node binary running Pi can no longer start Pi children or helpers. On macOS, Homebrew
 * resolves it to a versioned Cellar path that `brew upgrade` deletes while Pi keeps running. The
 * check reads the real path; the problem names it as the user reads it, in a clause that follows
 * the doctor's `Node:` label.
 */
export const nodeExecutableProblem = (
  executable = process.execPath,
): Effect.Effect<string | undefined> =>
  Effect.promise(() =>
    nodeFsPromises.access(executable, nodeFsConstants.X_OK).then(
      () => undefined,
      (cause: unknown) =>
        nodeErrorCode(cause) === "ENOENT"
          ? `${homeDisplayPath(executable)} was removed since Pi started; restart Pi`
          : `${homeDisplayPath(executable)} is no longer executable; restart Pi`,
    ),
  );

export const requireNodeExecutable = (executable = process.execPath) =>
  nodeExecutableProblem(executable).pipe(
    Effect.flatMap((problem) =>
      problem
        ? Effect.fail(invalidRequest("node_executable_missing", `Node ${problem}.`))
        : Effect.void,
    ),
  );
