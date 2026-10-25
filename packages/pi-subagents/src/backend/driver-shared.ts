import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { formatBytes } from "pi-cosmic-core/display";
import type { OversizedLine } from "../boundary/bounded-line-parser.ts";
import { jsonPrefixScalars } from "../boundary/json-prefix.ts";
import { MAX_PROCESS_LINE_BYTES } from "../boundary/process-transport.ts";
import type { BackendEvent } from "./model.ts";
import { SubagentProtocolError, type SubagentError } from "../run/errors.ts";

export const protocolError = (message: string): SubagentProtocolError =>
  SubagentProtocolError.make({ message });

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

interface CorrelatedRequestOptions<Frame, Response> {
  readonly timeout: Duration.Input;
  readonly register: (deferred: Deferred.Deferred<Response, SubagentError>) => {
    readonly frame: Frame;
    readonly unregister: Effect.Effect<void>;
  };
  readonly send: (frame: Frame) => Effect.Effect<void, SubagentError>;
  readonly timeoutError: (frame: Frame) => SubagentError;
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
      // A response can arrive before a send settles, so either one settles the request.
      const correlated = options.send(frame).pipe(Effect.andThen(Deferred.await(deferred)));
      return Effect.raceFirst(correlated, Deferred.await(deferred)).pipe(
        Effect.timeoutOrElse({
          duration: options.timeout,
          orElse: () => Effect.fail(options.timeoutError(frame)),
        }),
      );
    },
    ({ unregister }) => unregister,
  );
