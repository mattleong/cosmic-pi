import { createHash, randomUUID } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import type { LocalCliProcessHandle } from "../boundary/local-cli-process.ts";
import { processError, SubagentProcessError, type SubagentError } from "../run/errors.ts";
import type { SteeringDeliveryState } from "../run/model.ts";
import { claudeUserFrame } from "./local-claude-protocol.ts";

const CALLER_WAIT = "10 seconds";
// Absolute from native-send ownership, never extended by inbound activity.
const STEERING_ACK_WATCHDOG = "5 minutes";

/** Digest identity is diagnostic evidence only; it never authorizes a replay. */
export const userContentDigest = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

export interface PendingUserReplay {
  readonly uuid: string;
  readonly sequence: number;
  readonly operation: "initialize" | "start" | "steer";
  readonly contentDigest: string;
  readonly epoch: number;
  readonly emitRunStarted: boolean;
  readonly resultKind: "initialization" | "assignment" | undefined;
  readonly acknowledgement: Deferred.Deferred<void, SubagentError>;
  /** Start of backend delivery ownership, not proof of native write completion. */
  ownedAtMillis?: number | undefined;
}

export type ClaudeInputTerminationReason =
  | "write-uncertain"
  | "replay-deadline"
  | "steering-watchdog";
interface InputDeliveryObservers {
  readonly onState?: (
    input: PendingUserReplay,
    state: SteeringDeliveryState,
  ) => Effect.Effect<void>;
  /** Queries exact-epoch supervisor ownership and forwards through the existing report owner. */
  readonly preserveReport?: (epoch: number) => Effect.Effect<boolean>;
  readonly diagnose?: (
    input: PendingUserReplay,
    error: SubagentProcessError,
    reason: ClaudeInputTerminationReason,
  ) => Effect.Effect<SubagentProcessError>;
  readonly onFailure?: (error: SubagentProcessError) => Effect.Effect<void>;
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
  observers: InputDeliveryObservers = {},
) => {
  let pending: PendingUserReplay | undefined;
  let transportClosed: SubagentError | undefined;
  let failure: SubagentProcessError | undefined;
  let sequence = 0;
  const closedError = () =>
    failure ??
    transportClosed ??
    (scope.state._tag === "Closed"
      ? processError("send", "local_claude_closed", "Local Claude Code backend closed.")
      : undefined);
  const clear = (input: PendingUserReplay) => {
    if (pending === input) pending = undefined;
  };
  const publish = (input: PendingUserReplay, state: SteeringDeliveryState) =>
    input.operation === "steer" ? (observers.onState?.(input, state) ?? Effect.void) : Effect.void;
  const failUncertainDelivery = (
    input: PendingUserReplay,
    error: SubagentProcessError,
    reason: ClaudeInputTerminationReason,
  ) =>
    Effect.gen(function* () {
      // Close admission and latch the primary cause before any diagnostic/termination yield.
      failure ??= error;
      transportClosed = failure;
      failure = yield* observers.diagnose?.(input, failure, reason) ?? Effect.succeed(failure);
      // Queue backpressure cannot postpone termination after the failure latch. The exit
      // path carries the same typed cause even if event shutdown wins publication.
      yield* Effect.all(
        [
          publish(input, "unresolved").pipe(
            Effect.andThen(observers.onFailure?.(failure) ?? Effect.void),
          ),
          // A termination request is not cleanup proof. Scope release owns that evidence.
          child.terminate("force").pipe(Effect.ignore),
        ],
        { concurrency: "unbounded", discard: true },
      );
      return yield* failure;
    });
  const confirm = (input: PendingUserReplay): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (pending !== input || closedError()) return Effect.void;
      clear(input);
      Deferred.doneUnsafe(input.acknowledgement, Effect.void);
      return publish(input, "confirmed");
    });
  const acceptReport = (epoch: number): Effect.Effect<boolean> =>
    Effect.suspend(() => {
      const input = pending;
      if (!input || input.operation !== "steer" || input.epoch !== epoch || failure)
        return Effect.succeed(false);
      // Report acceptance proves assignment completion, not incorporation of the guidance.
      transportClosed = processError(
        "steer",
        "steer_outcome_uncertain",
        "The supervisor report was accepted while guidance acknowledgement remained unconfirmed. Do not resend the guidance.",
      );
      clear(input);
      Deferred.doneUnsafe(input.acknowledgement, Effect.fail(transportClosed));
      return publish(input, "report-unconfirmed").pipe(Effect.as(true));
    });
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
              "Another Claude stream-input delivery is awaiting native replay confirmation. The run remains owned; do not resend pending guidance. Stop remains available.",
            ),
          );
        const input: PendingUserReplay = {
          uuid: randomUUID(),
          sequence: ++sequence,
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
        const nativeSend = Effect.suspend(() => {
          const closed = closedError();
          return closed
            ? Effect.fail(closed)
            : child.send(claudeUserFrame(text, { shouldQuery, uuid: input.uuid }));
        }).pipe(
          Effect.tapError((error) =>
            error instanceof SubagentProcessError && error.code === "transport_outcome_uncertain"
              ? Effect.void
              : publish(input, "not-sent"),
          ),
        );
        const delivery = Clock.currentTimeMillis.pipe(
          Effect.tap((now) =>
            Effect.sync(() => {
              input.ownedAtMillis = now;
            }),
          ),
          Effect.andThen(publish(input, "pending")),
          Effect.andThen(nativeSend),
          Effect.andThen(Deferred.await(input.acknowledgement)),
          Effect.timeout(operation === "steer" ? STEERING_ACK_WATCHDOG : CALLER_WAIT),
          Effect.catchTag("TimeoutError", () =>
            Effect.gen(function* () {
              if (pending !== input || closedError())
                return yield* Deferred.await(input.acknowledgement);
              if (
                operation === "steer" &&
                (yield* observers.preserveReport?.(epoch) ?? Effect.succeed(false))
              )
                return yield* Deferred.await(input.acknowledgement);
              // The exact owner may have changed while report evidence was queried.
              if (pending !== input || closedError())
                return yield* Deferred.await(input.acknowledgement);
              return yield* failUncertainDelivery(
                input,
                processError(
                  operation,
                  `${operation}_outcome_uncertain`,
                  operation === "steer"
                    ? "Claude guidance native replay remained unconfirmed at the absolute five-minute acknowledgement watchdog. The backend is closing; delivery and incorporation remain unknown. Do not resend or retry this run."
                    : "Claude stream input was sent but native replay confirmation did not arrive within ten seconds; the backend is closing to prevent ambiguous retry correlation.",
                ),
                operation === "steer" ? "steering-watchdog" : "replay-deadline",
              );
            }),
          ),
          Effect.catchIf(
            (error) =>
              error instanceof SubagentProcessError && error.code === "transport_outcome_uncertain",
            () =>
              failUncertainDelivery(
                input,
                processError(
                  operation,
                  `${operation}_outcome_uncertain`,
                  "Claude stream input may already have been accepted; the backend is closing because the native write outcome is uncertain. Do not resend.",
                ),
                "write-uncertain",
              ),
          ),
          Effect.tap(() => confirm(input)),
          Effect.ensuring(Effect.sync(() => clear(input))),
          Effect.interruptible,
        );
        // Preparation remains caller-owned; send and acknowledgement transfer together.
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
          Effect.flatMap((fiber) =>
            restore(
              operation === "steer"
                ? Fiber.join(fiber).pipe(
                    Effect.timeoutOrElse({
                      duration: CALLER_WAIT,
                      orElse: () =>
                        Effect.fail(
                          closedError() ??
                            new SubagentProcessError({
                              operation: "steer",
                              code: "steer_outcome_uncertain",
                              pendingDelivery: true,
                              message:
                                "Claude guidance may have been sent, but native replay acknowledgement is still pending. The run remains running and backend-owned; do not resend. Await or inspect status; stop remains available. An absolute five-minute acknowledgement watchdog remains active.",
                            }),
                        ),
                    }),
                  )
                : Fiber.join(fiber),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (!transferred) clear(input);
            }),
          ),
        );
      }),
    );
  return {
    get pending() {
      return pending;
    },
    get failure() {
      return failure;
    },
    clear,
    confirm,
    acceptReport,
    send,
    cancel: (error: SubagentError) => {
      transportClosed ??= error;
      if (!pending) return;
      Deferred.doneUnsafe(pending.acknowledgement, Effect.fail(failure ?? error));
      pending = undefined;
    },
  };
};
