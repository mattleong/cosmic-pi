import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type { LocalCliWireEvent } from "../boundary/local-cli-transport.ts";
import { processError, SubagentProcessError, type SubagentError } from "../run/errors.ts";
import type { LocalCliRawEventOwnership } from "./local-cli-events.ts";

const INTERRUPT_TIMEOUT = "10 seconds";

/**
 * Classifies whether an interrupted native control call must retain its correlated lifecycle.
 * Typed uncertainty and interruption keep ownership; success and definite failure release it.
 */
export const classifyLocalCliInterruptOwnership = <A>(
  exit: Exit.Exit<A, SubagentError>,
): "release" | "retain" => {
  if (Exit.isSuccess(exit)) return "release";
  if (Cause.hasInterruptsOnly(exit.cause)) return "retain";
  return Cause.findErrorOption(exit.cause).pipe(
    Option.exists(
      (error) =>
        error instanceof SubagentProcessError && error.code === "interrupt_outcome_uncertain",
    ),
  )
    ? "retain"
    : "release";
};

/** One exactly owned native interrupt: a correlated response plus native terminal evidence. */
export interface LocalCliInterrupt {
  readonly epoch: number;
  readonly terminal: Deferred.Deferred<void, SubagentError>;
  /** The adapter's complete native terminal evidence arrived. */
  settled: boolean;
  /**
   * Set when the public interrupt call ended with an uncertain outcome. The lifecycle then
   * remains exactly owned: late terminal evidence settles the assignment through
   * `run_settled` instead of failing the run.
   */
  abandoned: boolean;
}

/**
 * Shared Claude/Codex interrupt ownership: one lifecycle at a time awaits its correlated
 * response and native terminal evidence. Each adapter decides which evidence completes it.
 */
export const makeLocalCliInterrupts = <Interrupt extends LocalCliInterrupt>(
  runtime: "Claude" | "Codex",
  events: Pick<LocalCliRawEventOwnership, "offer" | "release">,
  currentEpoch: () => number,
) => {
  let current: Interrupt | undefined;
  const settle = (interrupt: Interrupt, raw?: LocalCliWireEvent) => {
    current = undefined;
    return events.offer({ type: "run_settled", assignmentEpoch: interrupt.epoch }, raw);
  };
  return {
    get current() {
      return current;
    },
    /** Records complete terminal evidence; an abandoned lifecycle settles as a pause. */
    complete: (interrupt: Interrupt, raw: LocalCliWireEvent): Effect.Effect<void> =>
      Effect.suspend(() => {
        interrupt.settled = true;
        if (interrupt.abandoned) return settle(interrupt, raw);
        Deferred.doneUnsafe(interrupt.terminal, Effect.void);
        return events.release(raw);
      }),
    /** Transport closure is a safe boundary for clearing interrupt ownership. */
    cancel: (error: SubagentError): void => {
      if (!current) return;
      Deferred.doneUnsafe(current.terminal, Effect.fail(error));
      current = undefined;
    },
    run: (options: {
      /** An adapter reason not to send, checked inside admission before the lifecycle check. */
      readonly blocked?: () => SubagentError | undefined;
      readonly make: (base: LocalCliInterrupt) => Interrupt;
      /** Sends the native interrupt and awaits its correlated response. */
      readonly respond: (interrupt: Interrupt) => Effect.Effect<unknown, SubagentError>;
      readonly timeoutMessage: string;
      /** Drops adapter correlation state before ownership is classified. */
      readonly onRelease?: (interrupt: Interrupt) => void;
    }): Effect.Effect<void, SubagentError> =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const error =
            options.blocked?.() ??
            (current &&
              processError(
                "interrupt",
                "interrupt_not_sent",
                current.abandoned
                  ? `A previous ${runtime} interrupt lifecycle is still unresolved; a second interrupt would be ambiguously correlated.`
                  : `Another ${runtime} interrupt lifecycle is already pending.`,
              ));
          if (error) return { error } as const;
          current = options.make({
            epoch: currentEpoch(),
            terminal: Deferred.makeUnsafe<void, SubagentError>(),
            settled: false,
            abandoned: false,
          });
          return { interrupt: current } as const;
        }),
        (acquired) =>
          acquired.error
            ? Effect.fail(acquired.error)
            : Effect.all(
                [options.respond(acquired.interrupt), Deferred.await(acquired.interrupt.terminal)],
                { concurrency: "unbounded", discard: true },
              ).pipe(
                Effect.timeoutOrElse({
                  duration: INTERRUPT_TIMEOUT,
                  orElse: () =>
                    Effect.fail(
                      processError(
                        "interrupt",
                        "interrupt_outcome_uncertain",
                        options.timeoutMessage,
                      ),
                    ),
                }),
              ),
        ({ interrupt }, exit) =>
          Effect.suspend(() => {
            if (!interrupt) return Effect.void;
            options.onRelease?.(interrupt);
            if (current !== interrupt) return Effect.void;
            // An uncertain or cancelled interrupt retains exact lifecycle ownership; definite
            // success or rejection releases it immediately.
            if (classifyLocalCliInterruptOwnership(exit) === "release") {
              current = undefined;
              return Effect.void;
            }
            interrupt.abandoned = true;
            // Terminal evidence may already be complete while only the correlated response is
            // missing. Settle now, or no later native event would resolve the pending pause.
            return interrupt.settled ? settle(interrupt) : Effect.void;
          }),
      ),
  };
};
