import { createHash, randomUUID } from "node:crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import type { LocalCliProcessHandle } from "../boundary/local-cli-process.ts";
import {
  isOutcomeUncertain,
  processError,
  SubagentProcessError,
  type SubagentError,
} from "../run/errors.ts";
import { claudeUserFrame } from "./local-claude-protocol.ts";

/** Digest identity of stream-input text, compared against native replays. */
export const userContentDigest = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

export interface PendingUserReplay {
  readonly uuid: string;
  readonly operation: "initialize" | "start" | "steer";
  readonly contentDigest: string;
  readonly epoch: number;
  readonly emitRunStarted: boolean;
  readonly resultKind: "initialization" | "assignment" | undefined;
  readonly acknowledgement: Deferred.Deferred<void, SubagentError>;
}

/** Owns outbound UUIDs through native replay, independently of control callers. */
export const makeLocalClaudeInputDelivery = (
  child: Pick<LocalCliProcessHandle, "send" | "terminate">,
  scope: Scope.Scope,
  recordOutbound: (
    operation: PendingUserReplay["operation"],
    epoch: number,
    shouldQuery: boolean,
  ) => Effect.Effect<void>,
) => {
  let pending: PendingUserReplay | undefined;
  let transportClosed: SubagentError | undefined;
  const closedError = () =>
    transportClosed ??
    (scope.state._tag === "Closed"
      ? processError("send", "local_claude_closed", "Local Claude Code backend closed.")
      : undefined);
  const clear = (input: PendingUserReplay) => {
    if (pending === input) pending = undefined;
  };
  const failUncertainDelivery = (error: SubagentError) =>
    child.terminate("force").pipe(Effect.ignore, Effect.andThen(Effect.fail(error)));
  const send = (
    text: string,
    epoch: number,
    operation: PendingUserReplay["operation"],
    shouldQuery = true,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const closed = closedError();
        if (closed) return Effect.fail(closed);
        if (pending)
          return Effect.fail(
            processError(
              operation,
              `${operation}_not_sent`,
              "Another Claude stream-input delivery is awaiting native replay confirmation.",
            ),
          );
        const input: PendingUserReplay = {
          uuid: randomUUID(),
          operation,
          epoch,
          emitRunStarted: operation === "start",
          contentDigest: userContentDigest(text),
          resultKind:
            operation === "initialize"
              ? "initialization"
              : operation === "start"
                ? "assignment"
                : undefined,
          acknowledgement: Deferred.makeUnsafe<void, SubagentError>(),
        };
        pending = input;
        let transferred = false;
        const delivery = Effect.suspend(() => {
          const closed = closedError();
          return closed
            ? Effect.fail(closed)
            : child.send(claudeUserFrame(text, { shouldQuery, uuid: input.uuid }));
        }).pipe(
          Effect.mapError((error) =>
            error instanceof SubagentProcessError && error.code === "transport_outcome_uncertain"
              ? processError(
                  operation,
                  `${operation}_outcome_uncertain`,
                  `Claude stream input may already have been accepted; inspect run status before retrying. (${error.message})`,
                )
              : error,
          ),
          Effect.catch((error) =>
            error instanceof SubagentProcessError && isOutcomeUncertain(error)
              ? failUncertainDelivery(error)
              : Effect.fail(error),
          ),
          Effect.andThen(Deferred.await(input.acknowledgement)),
          Effect.timeout("10 seconds"),
          Effect.catchTag("TimeoutError", () =>
            failUncertainDelivery(
              processError(
                operation,
                `${operation}_outcome_uncertain`,
                "Claude stream input was sent but native replay confirmation did not arrive; the backend was closed to prevent ambiguous retry correlation.",
              ),
            ),
          ),
          Effect.ensuring(Effect.sync(() => clear(input))),
          Effect.interruptible,
        );
        // Preparation stays caller-owned. Only admission to the native send transfers
        // ownership; the mask makes that handoff atomic with scope registration.
        return restore(recordOutbound(operation, epoch, shouldQuery)).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              delivery.pipe(
                Effect.forkIn(scope, { startImmediately: true }),
                Effect.tap(() =>
                  Effect.sync(() => {
                    transferred = true;
                  }),
                ),
              ),
            ),
          ),
          Effect.flatMap((fiber) => restore(Fiber.join(fiber))),
          Effect.ensuring(
            Effect.sync(() => {
              if (!transferred || closedError()) clear(input);
            }),
          ),
        );
      }),
    );
  return {
    get pending() {
      return pending;
    },
    clear,
    send,
    cancel: (error: SubagentError) => {
      transportClosed = error;
      if (!pending) return;
      Deferred.doneUnsafe(pending.acknowledgement, Effect.fail(error));
      pending = undefined;
    },
  };
};
