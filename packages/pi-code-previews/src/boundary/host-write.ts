import {
  createWriteTool,
  createWriteToolDefinition,
  type ExtensionContext,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

/** Pi's Promise-only operation callbacks borrow this invocation's services and scope.
 * Joining the scoped worker without an abort signal keeps Pi's queue held until
 * an admitted masked filesystem operation has actually settled.
 */
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
  onError: () => E,
  ctx?: ExtensionContext,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Effect.context<R>();
      const scope = yield* Effect.scope;
      const run = <A>(effect: Effect.Effect<A, E, R>) =>
        Effect.runPromiseWith(services)(
          effect.pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
        );
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
