import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  processError,
  SubagentProtocolError,
  type SubagentError,
  type SubagentProcessError,
} from "../run/errors.ts";

export const protocolError = (message: string): SubagentProtocolError =>
  new SubagentProtocolError({ message });

export const supervisorError =
  (operation: string) =>
  ({ code, message }: { readonly code: string; readonly message: string }): SubagentProcessError =>
    processError(operation, code, message);

interface CorrelatedRequestOptions<Frame, Response> {
  readonly timeout: Duration.Input;
  readonly register: (deferred: Deferred.Deferred<Response, SubagentError>) => {
    readonly frame: Frame;
    readonly unregister: Effect.Effect<void>;
  };
  readonly send: (frame: Frame) => Effect.Effect<void, SubagentError>;
  readonly timeoutError: (frame: Frame) => SubagentError;
  readonly awaitEarlyResponse?: boolean | undefined;
}

export const correlatedRequest = <Frame, Response>(
  options: CorrelatedRequestOptions<Frame, Response>,
): Effect.Effect<Response, SubagentError> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const deferred = Deferred.makeUnsafe<Response, SubagentError>();
      return { deferred, ...options.register(deferred) };
    }),
    ({ deferred, frame }) => {
      const correlated = options.send(frame).pipe(Effect.andThen(Deferred.await(deferred)));
      return (
        options.awaitEarlyResponse
          ? Effect.raceFirst(correlated, Deferred.await(deferred))
          : correlated
      ).pipe(
        Effect.timeoutOrElse({
          duration: options.timeout,
          orElse: () => Effect.fail(options.timeoutError(frame)),
        }),
      );
    },
    ({ unregister }) => unregister,
  );
