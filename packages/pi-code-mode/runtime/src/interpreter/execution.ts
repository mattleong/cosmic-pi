import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import type { RuntimeFailure } from "../failure.js";
import { observeHost } from "../tool-error.js";
import { ToolRuntime } from "../tool-runtime.js";
import { SandboxPromise } from "../values.js";
import { assertBoundedPendingWork } from "./confinement.js";
import { hoistVarDeclarations, predeclareLexicals } from "./scope.js";
import {
  type AstNode,
  type InterpreterArray,
  InterpreterRuntimeError,
  type InterpreterValue,
  type ProgramNode,
} from "./model.js";
import { attachErrorSite } from "./diagnostics.js";
import { currentScope, popScope, pushScope } from "./scope.js";
import { evaluateStatement, hoistFunctions } from "./statements.js";
import { type Activation, type ExecutionOptions, makeRootActivation } from "./activation.js";
import { normalizeError } from "./diagnostics.js";

/** Runs a parsed program in a fresh execution. */
export const runProgram = <R>(
  program: ProgramNode,
  options: ExecutionOptions<R>,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> => run(makeRootActivation(options), program);

export function run<R>(
  act: Activation<R>,
  program: ProgramNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  // Run the program body in its own module scope on top of the builtin global scope, so
  // top-level declarations (`let undefined = 5`, `const Object = ...`) shadow builtins like
  // JS module scope, instead of colliding with the seeded globals.
  pushScope(act);
  return Effect.gen(function* () {
    yield* act.execution.turns.take(act.turn);
    act.functionScope = currentScope(act);
    predeclareLexicals(act.functionScope, program.body);
    hoistVarDeclarations(act.functionScope, program.body);
    hoistFunctions(act, program.body);
    let value: InterpreterValue = undefined;
    let returned = false;
    for (const statement of program.body) {
      const result = yield* evaluateStatement(act, statement);

      if (result.kind === "return") {
        value = result.value;
        returned = true;
        break;
      }

      if (result.kind === "break" || result.kind === "continue") {
        throw new InterpreterRuntimeError(
          `Unexpected '${result.kind}' outside of a loop.`,
          statement,
        );
      }

      if (result.kind === "value") {
        act.lastValue = result.value;
      }
    }
    if (!returned) value = act.lastValue;

    // The program body runs inside an implicit async function, so a returned promise
    // resolves before crossing the data boundary - `return tools.ns.tool(...)` works
    // without an explicit await, exactly as in JS.
    yield* releaseTurn(act);
    if (value instanceof SandboxPromise) value = yield* settlePromise(act, value);
    yield* drainPendingSettlements(act);
    return value;
  }).pipe(
    Effect.onExit((exit) => Scope.close(act.execution.scope, exit)),
    Effect.ensuring(releaseTurn(act)),
    Effect.ensuring(Effect.sync(() => popScope(act))),
  );
}

export function releaseTurn<R>(act: Activation<R>): Effect.Effect<void> {
  return Effect.suspend(() => {
    if (!act.turn.held) return Effect.void;
    act.turn.held = false;
    return act.execution.turns.release();
  });
}

/** Takes a guest turn to continue this activation; a continuation starts at call depth 0. */
export function takeTurn<R>(act: Activation<R>): Effect.Effect<void> {
  return Effect.andThen(
    act.execution.turns.take(act.turn),
    Effect.sync(() => {
      act.callDepth = 0;
    }),
  );
}

/**
 * Ends the current guest turn. A caller still waiting for this activation's synchronous prefix
 * (an async function call that has not returned its promise yet) resumes now.
 */
export function endSynchronousPrefix<R>(act: Activation<R>): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* releaseTurn(act);
    const boundary = act.firstBoundary;
    act.firstBoundary = undefined;
    if (boundary !== undefined) yield* Deferred.succeed(boundary, undefined);
  });
}

/**
 * The await protocol: end this guest turn, wait for `settlement` while other guest work runs,
 * then take a turn back and continue with its outcome.
 */
export function suspendAtAwait<R, A>(
  act: Activation<R>,
  settlement: Effect.Effect<A, RuntimeFailure>,
): Effect.Effect<A, RuntimeFailure> {
  return Effect.gen(function* () {
    yield* endSynchronousPrefix(act);
    const settled = yield* Effect.exit(settlement);
    yield* takeTurn(act);
    return yield* settled;
  });
}

/**
 * Live asynchronous work in an execution. A running promise is both active and, until something
 * observes it, in the unobserved ledger; the larger of the two counts each promise once.
 */
export const pendingWork = <R>(act: Activation<R>): number =>
  Math.max(act.execution.activePromises, act.execution.pendingSettlements.size);

/**
 * Starts `work` on an execution-owned fiber behind a promise. A caller that settles the promise
 * logically before the fiber ends (async functions, combinators) passes that promise in.
 */
export function startPromise<R>(
  act: Activation<R>,
  work: Effect.Effect<InterpreterValue, RuntimeFailure, R>,
  descendants?: Set<SandboxPromise>,
  promise: SandboxPromise = new SandboxPromise(descendants),
): Effect.Effect<SandboxPromise, never, R> {
  // Admission and observer installation are atomic with respect to cancellation. The
  // child work itself remains interruptible, including its synchronous guest prefix.
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      assertBoundedPendingWork(pendingWork(act) + 1, "Pending promises");
      act.execution.activePromises++;
      const owned =
        descendants === undefined
          ? work
          : work.pipe(
              Effect.onInterrupt(() =>
                Effect.forEach(
                  descendants,
                  (child) => interruptPromise(act, child, promise.interrupted),
                  { discard: true },
                ),
              ),
            );
      const fiber = yield* Effect.forkIn(
        restore(owned.pipe(Effect.onExit((exit) => Effect.sync(() => promise.settle(exit))))),
        act.execution.scope,
        {
          startImmediately: true,
        },
      );
      promise.fiber = fiber;
      for (const owner of act.owners) owner.add(promise);
      act.execution.pendingSettlements.add(promise);
      fiber.addObserver((exit) => {
        act.execution.activePromises--;
        for (const owner of act.owners) owner.delete(promise);
        // Keep only live work and unobserved failures, not every completed invocation.
        if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
          act.execution.pendingSettlements.delete(promise);
        }
      });
      return promise;
    }),
  );
}

export function interruptPromise<R>(
  act: Activation<R>,
  promise: SandboxPromise,
  raceInterrupted: boolean,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    // Cancelling an ancestor would cancel this race itself and form an interruption
    // wait cycle. Cross-linked sibling races likewise must not re-enter cancellation.
    if (
      (raceInterrupted &&
        promise.descendants !== undefined &&
        act.owners.some((owner) => owner === promise.descendants)) ||
      act.execution.interrupting.has(promise)
    )
      return Effect.void;
    act.execution.interrupting.add(promise);
    return Effect.gen(function* () {
      if (raceInterrupted) promise.interrupted = true;
      if (promise.fiber !== undefined) yield* Fiber.interrupt(promise.fiber);
      // Completed losing activations can still own live descendants.
      yield* Effect.forEach(
        promise.descendants ?? [],
        (child) => interruptPromise(act, child, raceInterrupted),
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(Effect.ensuring(Effect.sync(() => act.execution.interrupting.delete(promise))));
  }).pipe(Effect.uninterruptible);
}

export function promiseReaction<R, A, B, Requirements = never>(
  act: Activation<R>,
  settlement: Effect.Effect<A, RuntimeFailure>,
  reaction: (value: A) => Effect.Effect<B, RuntimeFailure, Requirements>,
): Effect.Effect<B, RuntimeFailure, Requirements> {
  return Effect.flatMap(Effect.exit(settlement), (exit) => {
    if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
      return Effect.failCause(exit.cause);
    return act.execution.turns.withPermit(
      Exit.isSuccess(exit)
        ? Effect.suspend(() => {
            act.callDepth = 0;
            return reaction(exit.value);
          })
        : Effect.failCause(exit.cause),
    );
  });
}

export function drainPendingSettlements<R>(
  act: Activation<R>,
): Effect.Effect<void, RuntimeFailure, never> {
  return Effect.gen(function* () {
    // Keep failures in the bounded ledger until continuations have had a chance to
    // observe them. A later async turn can legitimately attach a rejection handler.
    const failures = new Set<SandboxPromise>();
    while (true) {
      const batch = Array.from(act.execution.pendingSettlements).filter(
        (promise) => !failures.has(promise),
      );
      if (batch.length === 0) break;
      for (const promise of batch) {
        act.execution.deadline.check();
        if (!act.execution.pendingSettlements.has(promise)) continue;
        const exit = yield* promiseSettlement(promise);
        if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause))
          act.execution.pendingSettlements.delete(promise);
        else failures.add(promise);
      }
    }
    for (const promise of failures) {
      if (!act.execution.pendingSettlements.has(promise)) continue;
      const exit = yield* promiseSettlement(promise);
      if (Exit.isSuccess(exit)) continue;
      const failure = normalizeError(Cause.squash(exit.cause));
      throw new InterpreterRuntimeError(
        `Unhandled rejection from an un-awaited promise: ${failure.message}`,
        undefined,
        failure.kind,
        [
          "Await async functions and tool calls - `const result = await tools.ns.tool(...)` - so failures can be caught and handled.",
        ],
      );
    }
  });
}

export function createToolCallPromise<R>(
  act: Activation<R>,
  path: ReadonlyArray<string>,
  args: InterpreterArray,
  node: AstNode,
): Effect.Effect<SandboxPromise, never, R> {
  const id = act.execution.nextToolCallLifecycleId++;
  const name = path.join(".");
  const onLifecycle = act.execution.onToolCallLifecycle;
  const emit = (event: ToolRuntime.ToolCallLifecycleEvent): Effect.Effect<void, never, R> =>
    onLifecycle === undefined ? Effect.void : observeHost(() => onLifecycle(event));
  const lifecycle = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const queuedAt = yield* Clock.currentTimeMillis;
      yield* emit({ id, name, status: "queued" });
      let startedAt = queuedAt;
      let started = false;
      const invoked = Effect.gen(function* () {
        // Refusals (unknown tool, invalid input, call limit) settle here, without waiting
        // for a concurrency permit and without ever reporting the call as running.
        const call = yield* act.execution.admitTool(
          path,
          args,
          act.execution.onToolCallLifecycle === undefined ? undefined : id,
        );
        return yield* act.execution.callPermits
          .withPermit(
            Effect.gen(function* () {
              // Confinement: a queued call can wait for a permit past the cooperative deadline
              // while no guest step runs. Recheck after admission so expired work settles as a
              // failed, never-started call before running observation or host dispatch.
              act.execution.deadline.check();
              startedAt = yield* Clock.currentTimeMillis;
              started = true;
              yield* emit({
                id,
                name,
                status: "running",
                queueDurationMs: Math.max(0, startedAt - queuedAt),
              });
              return yield* restore(call.run);
            }),
          )
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (!started) call.withdraw();
              }),
            ),
          );
      });
      const exit = yield* Effect.exit(restore(invoked));
      // A tool failure is reported at the call that made it, not at the await that saw it.
      if (Exit.isFailure(exit)) attachErrorSite(Cause.squash(exit.cause), node);
      const endedAt = yield* Clock.currentTimeMillis;
      const queueDurationMs = Math.max(0, startedAt - queuedAt);
      // The same diagnostic the program would see, so hosts can explain calls that never ran.
      const failure =
        Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
          ? normalizeError(Cause.squash(exit.cause))
          : undefined;
      yield* emit({
        id,
        name,
        status: Exit.isSuccess(exit) ? "succeeded" : failure === undefined ? "cancelled" : "failed",
        started,
        durationMs: Math.max(0, endedAt - queuedAt),
        queueDurationMs: started ? queueDurationMs : Math.max(0, endedAt - queuedAt),
        ...(failure !== undefined && {
          failure: {
            kind: failure.kind,
            message: failure.message,
            ...(failure.facts !== undefined && { facts: failure.facts }),
          },
        }),
      });
      if (Exit.isSuccess(exit)) return exit.value;
      return yield* Effect.failCause(exit.cause);
    }),
  );
  return startPromise(act, lifecycle);
}

export function observePromise<R>(
  act: Activation<R>,
  promise: SandboxPromise,
): Effect.Effect<Exit.Exit<InterpreterValue, RuntimeFailure>> {
  act.execution.pendingSettlements.delete(promise);
  return promiseSettlement(promise);
}

export function promiseSettlement(
  promise: SandboxPromise,
): Effect.Effect<Exit.Exit<InterpreterValue, RuntimeFailure>> {
  return promise.outcome();
}

export function settlePromise<R>(
  act: Activation<R>,
  promise: SandboxPromise,
  node?: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, never> {
  return Effect.flatMap(observePromise(act, promise), (exit) =>
    unwrapPromiseExit(promise, exit, node),
  );
}

export function unwrapPromiseExit(
  promise: SandboxPromise | undefined,
  exit: Exit.Exit<InterpreterValue, RuntimeFailure>,
  node?: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure> {
  return settledExit(promise, exit, node);
}

/**
 * A settled promise's outcome as the program sees it. A call Promise.race interrupted after
 * losing settles as a catchable program failure; any other interruption is execution
 * teardown (timeout/host) and keeps propagating as interruption, never program data.
 */
export function settledExit(
  promise: SandboxPromise | undefined,
  exit: Exit.Exit<InterpreterValue, RuntimeFailure>,
  node?: AstNode,
): Exit.Exit<InterpreterValue, RuntimeFailure> {
  if (Exit.isSuccess(exit) || promise?.interrupted !== true || !Cause.hasInterruptsOnly(exit.cause))
    return exit;
  return Exit.fail(
    new InterpreterRuntimeError(
      "This tool call was interrupted because another value settled a Promise.race first.",
      node,
    ),
  );
}

/**
 * Runs `record` as a turn job once `input` settles, marking the input observed. A plain value
 * is an already settled input. Combinators use this instead of a fiber per input.
 */
export function observeInput<R>(
  act: Activation<R>,
  input: InterpreterValue,
  record: (exit: Exit.Exit<InterpreterValue, RuntimeFailure>) => void,
): void {
  const turns = act.execution.turns;
  if (!(input instanceof SandboxPromise)) {
    turns.enqueue(() => record(Exit.succeed(input)));
    return;
  }
  act.execution.pendingSettlements.delete(input);
  input.onSettled((exit) => turns.enqueue(() => record(exit)));
}

/**
 * Resolves `promise` with a reaction's result. A returned promise is adopted as in JS: one
 * job registers the follow-up on it, and the follow-up settles `promise` in a later job.
 */
export function resolvePromise<R>(
  act: Activation<R>,
  promise: SandboxPromise,
  result: Exit.Exit<InterpreterValue, RuntimeFailure>,
): void {
  if (Exit.isFailure(result) || !(result.value instanceof SandboxPromise)) {
    promise.settle(result);
    return;
  }
  const adopted = result.value;
  if (adopted === promise) {
    promise.settle(
      Exit.fail(new InterpreterRuntimeError("A promise cannot resolve to itself.").as("TypeError")),
    );
    return;
  }
  act.execution.turns.enqueue(() =>
    observeInput(act, adopted, (exit) => promise.settle(settledExit(adopted, exit))),
  );
}

/**
 * Awaits a promise for iterator protocol code: ends this guest turn, waits for settlement, and
 * takes the turn back, with a fresh synchronous call depth.
 */
export function awaitIteratorPromise<R>(
  act: Activation<R>,
  promise: SandboxPromise,
  node?: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure> {
  return suspendAtAwait(act, settlePromise(act, promise, node));
}
