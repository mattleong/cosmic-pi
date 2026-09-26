import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  processError,
  SubagentProtocolError,
  UnsupportedSubagentCapabilityError,
  type SubagentError,
  type SubagentProcessError,
} from "../run/errors.ts";

/**
 * Shared backend protocol failure factory. Each driver keeps its own backend tag and
 * message template; only the error construction is shared.
 */
export const protocolError = (message: string): SubagentProtocolError =>
  new SubagentProtocolError({ message });

/** Maps a supervisor channel failure to the process error of one backend operation. */
export const supervisorError =
  (operation: string) =>
  ({ code, message }: { readonly code: string; readonly message: string }): SubagentProcessError =>
    processError(operation, code, message);

/**
 * Shared unsupported-capability failure factory. Each driver binds its own backend tag
 * and message template verbatim at its call sites.
 */
export const unsupported = (
  backend: string,
  capability: string,
  message: string,
): UnsupportedSubagentCapabilityError =>
  new UnsupportedSubagentCapabilityError({ backend, capability, message });

export interface CorrelatedRequestOptions<Frame, Response> {
  /** Correlated-response wait bound; timeouts fail with `timeoutError` and never retry. */
  readonly timeout: Duration.Input;
  /**
   * Runs inside `Effect.sync` on acquisition: allocates the deferred, registers it in the
   * backend's response registry keyed by the produced frame identity, and returns the
   * outbound frame plus the release-time unregister that deletes exactly that entry.
   */
  readonly register: (deferred: Deferred.Deferred<Response, SubagentError>) => {
    readonly frame: Frame;
    readonly unregister: Effect.Effect<void>;
  };
  /** Send-side transport uncertainty must already be mapped by the caller. */
  readonly send: (frame: Frame) => Effect.Effect<void, SubagentError>;
  /** Failure used when the correlated response does not arrive within `timeout`. */
  readonly timeoutError: (frame: Frame) => SubagentError;
  /**
   * When set (local-pi), the send+await attempt races a bare deferred await so a response
   * settled by the event consumer resolves immediately.
   */
  readonly awaitEarlyResponse?: boolean | undefined;
}

/**
 * Shared acquire/use/release skeleton for correlated backend requests: register the
 * deferred inside `Effect.sync`, send, await the correlated response under a timeout,
 * and unregister exactly the registered entry on release. A send failure surfaces before
 * the deferred await; the timeout failure never retries.
 */
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
