import {
  createWriteTool,
  createWriteToolDefinition,
  type ExtensionToolContext,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";

export const executeNativeWrite = <E, R>(
  toolCallId: string,
  path: string,
  content: string,
  cwd: string,
  operations: {
    readonly mkdir: (directory: string) => Effect.Effect<void, E, R>;
    readonly writeFile: (
      absolutePath: string,
      content: string,
      signal: AbortSignal,
    ) => Effect.Effect<void, E, R>;
  },
  onError: (cause: unknown) => E,
  ctx?: ExtensionToolContext,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      // Workers belong to the invocation's scope; their Promises take no abort signal.
      const run = yield* FiberSet.makeRuntimePromise<R>();
      return yield* Effect.tryPromise({
        try: (signal) => {
          const nativeOperations: WriteOperations = {
            mkdir: (directory) => run(operations.mkdir(directory)),
            writeFile: (absolutePath, next) =>
              run(operations.writeFile(absolutePath, next, signal)),
          };
          const options = { operations: nativeOperations };
          return ctx
            ? createWriteToolDefinition(cwd, options).execute(
                toolCallId,
                { path, content },
                signal,
                undefined,
                ctx,
              )
            : createWriteTool(cwd, options).execute(toolCallId, { path, content }, signal);
        },
        catch: onError,
      });
    }),
  );
