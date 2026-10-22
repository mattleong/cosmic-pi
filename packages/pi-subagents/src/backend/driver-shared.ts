import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { formatBytes } from "pi-cosmic-core";
import type { OversizedLine } from "../boundary/bounded-line-parser.ts";
import { jsonPrefixScalars } from "../boundary/json-prefix.ts";
import { MAX_PROCESS_LINE_BYTES } from "../boundary/process-transport.ts";
import type { BackendEvent } from "./model.ts";
import {
  processError,
  SubagentProtocolError,
  type SubagentError,
  type SubagentProcessError,
} from "../run/errors.ts";

export const protocolError = (message: string): SubagentProtocolError =>
  new SubagentProtocolError({ message });

/** Stands in for tool output whose transport line exceeded the limit. */
export const omittedOutputPreview = (bytes: number): string =>
  `Output not shown: ${formatBytes(bytes)} exceeds the ${formatBytes(MAX_PROCESS_LINE_BYTES)} line limit.`;

export const oversizedLineError = (source: string, line: OversizedLine): BackendEvent => {
  const type = jsonPrefixScalars(line.prefix).get("type");
  const event = Predicate.isString(type) ? `${type} event` : "unrecognized line";
  return {
    type: "protocol_error",
    message: `${source} emitted a ${formatBytes(line.bytes)} ${event}, over the ${formatBytes(MAX_PROCESS_LINE_BYTES)} line limit.`,
  };
};

/**
 * Ends a background consumer without failing its scope. Its handlers have no typed failures, so a
 * non-interrupt cause is a defect that stops delivery; it is logged with a fixed message, never its
 * content, which may quote child output.
 */
export const ignoreConsumerCause =
  (consumer: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    self.pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError(`Subagent ${consumer} stopped unexpectedly.`),
      ),
      Effect.ignoreCause,
    );

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
