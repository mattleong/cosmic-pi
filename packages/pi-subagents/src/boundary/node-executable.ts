import * as Effect from "effect/Effect";
import { invalidRequest } from "../run/errors.ts";
import { nodeErrorCode } from "./harness-shared.ts";
import { nodeFsConstants, nodeFsPromises } from "pi-cosmic-core";

/**
 * Why the Node binary running Pi can no longer start Pi children or helpers. On macOS, Homebrew
 * resolves it to a versioned Cellar path that `brew upgrade` deletes while Pi keeps running.
 */
export const nodeExecutableProblem = (
  executable = process.execPath,
): Effect.Effect<string | undefined> =>
  Effect.promise(() =>
    nodeFsPromises.access(executable, nodeFsConstants.X_OK).then(
      () => undefined,
      (cause: unknown) =>
        nodeErrorCode(cause) === "ENOENT"
          ? `Node at ${executable} was removed since Pi started; restart Pi.`
          : `Node at ${executable} is no longer executable; restart Pi.`,
    ),
  );

export const requireNodeExecutable = (executable = process.execPath) =>
  nodeExecutableProblem(executable).pipe(
    Effect.flatMap((problem) =>
      problem ? Effect.fail(invalidRequest("node_executable_missing", problem)) : Effect.void,
    ),
  );
