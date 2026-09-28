import * as Predicate from "effect/Predicate";
import { materializeIterable } from "./iterator-protocol.js";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { RuntimeFailure } from "../failure.js";
import { hasObjectRuntimeType } from "../runtime-values.js";
import { spreadItems } from "../stdlib/collections.js";
import { coerceToString } from "./conversions.js";
import { SandboxPromise, createErrorValue, attachErrorCause } from "../values.js";
import { assertBoundedCollectionSize } from "./confinement.js";
import {
  type AstNode,
  type InterpreterArray,
  type InterpreterObject,
  InterpreterRuntimeError,
  type InterpreterValue,
  isCallableReference,
  makeInterpreterObject,
  ProgramThrow,
  PromiseMethodReference,
} from "./model.js";
import { invokeCallable } from "./callable.js";
import {
  interruptPromise,
  promiseReaction,
  settlePromise,
  startPromise,
  observeInput,
  resolvePromise,
  settledExit,
  pendingWork,
} from "./execution.js";
import { type Activation, forkActivation } from "./activation.js";
import { caughtErrorValue } from "./diagnostics.js";

export function constructAggregateError(args: InterpreterArray, node: AstNode): InterpreterObject {
  const errors = Array.isArray(args[0]) ? Array.from(args[0]) : spreadItems(args[0]);
  if (errors === undefined)
    throw new InterpreterRuntimeError("AggregateError expects a supported iterable.", node).as(
      "TypeError",
    );
  assertBoundedCollectionSize(errors.length, "AggregateError errors", node);
  const result = createErrorValue(
    "AggregateError",
    args[1] === undefined ? "" : coerceToString(args[1]),
  );
  Object.defineProperty(result, "errors", { value: errors, writable: true, configurable: true });
  attachErrorCause(result, args[2]);
  return result;
}

export function chainReaction<R>(
  act: Activation<R>,
  source: SandboxPromise,
  reaction: (
    exit: Exit.Exit<InterpreterValue, RuntimeFailure>,
  ) => Effect.Effect<InterpreterValue, RuntimeFailure, R>,
  descendants: Set<SandboxPromise>,
): Effect.Effect<SandboxPromise, never, R> {
  const observed = Effect.exit(settlePromise(act, source));
  const promise = new SandboxPromise(descendants);
  const work = Effect.gen(function* () {
    yield* promiseReaction(act, observed, (exit) =>
      Effect.gen(function* () {
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
          return yield* Effect.failCause(exit.cause);
        resolvePromise(act, promise, yield* Effect.exit(Effect.suspend(() => reaction(exit))));
      }),
    );
    // The chain settles logically inside its reaction or adoption job; wait for it here.
    return yield* Effect.flatten(promise.outcome());
  });
  return startPromise(act, work, descendants, promise);
}

export function invokePromiseChain<R>(
  act: Activation<R>,
  source: SandboxPromise,
  name: string,
  args: InterpreterArray,
  node: AstNode,
): Effect.Effect<SandboxPromise, never, R> {
  const activation = forkActivation(act);
  const descendants = new Set<SandboxPromise>();
  activation.turn = { held: false };
  activation.owners = [...act.owners, descendants];
  return chainReaction(
    act,
    source,
    (exit) => {
      // This child was captured when the handler was registered. A reaction starts
      // a fresh guest continuation, not the registrar's synchronous ancestry.
      activation.callDepth = 0;
      const handler =
        name === "catch"
          ? Exit.isFailure(exit)
            ? args[0]
            : undefined
          : name === "finally"
            ? args[0]
            : args[Exit.isSuccess(exit) ? 0 : 1];
      if (!isCallableReference(handler))
        return Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause);
      return Effect.gen(function* () {
        const result = yield* invokeCallable(
          activation,
          handler,
          name === "finally"
            ? []
            : [Exit.isSuccess(exit) ? exit.value : caughtErrorValue(Cause.squash(exit.cause))],
          node,
        );
        if (name !== "finally") return result;
        const cleanup =
          result instanceof SandboxPromise ? result : SandboxPromise.settled(Exit.succeed(result));
        return yield* chainReaction(
          activation,
          cleanup,
          (cleaned) => {
            if (Exit.isFailure(cleaned)) return Effect.failCause(cleaned.cause);
            return Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause);
          },
          new Set(),
        );
      });
    },
    descendants,
  );
}

export function invokePromiseMethod<R>(
  act: Activation<R>,
  ref: PromiseMethodReference,
  args: InterpreterArray,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  if (ref.name === "resolve" || ref.name === "reject") {
    return evaluatePromiseMethod(act, ref, args, node);
  }
  return Effect.gen(function* () {
    const source = args[0];
    if (source == null || (!Predicate.isString(source) && !hasObjectRuntimeType(source)))
      return yield* startPromise(
        act,
        Effect.fail(
          new InterpreterRuntimeError(
            `Promise.${ref.name} expects an array or supported iterable of promises or plain values.`,
            node,
          ).as("TypeError"),
        ),
      );
    const consumed = yield* Effect.exit(
      materializeIterable(act, source, node, `Promise.${ref.name} inputs`),
    );
    if (Exit.isFailure(consumed)) return yield* startPromise(act, Effect.failCause(consumed.cause));
    const items = consumed.value;
    if (items?.length === 0 && (ref.name === "all" || ref.name === "allSettled"))
      return SandboxPromise.settled(Exit.succeed([]));
    const inputs = items === undefined ? args : [items];
    const promise = new SandboxPromise();
    return yield* startPromise(
      act,
      Effect.suspend(() => evaluatePromiseMethod(act, ref, inputs, node, promise)).pipe(
        Effect.onInterrupt(() =>
          Effect.forEach(
            items ?? [],
            (item) => {
              return item instanceof SandboxPromise
                ? interruptPromise(act, item, true)
                : Effect.void;
            },
            { discard: true },
          ),
        ),
      ),
      undefined,
      promise,
    );
  });
}

export function evaluatePromiseMethod<R>(
  act: Activation<R>,
  ref: PromiseMethodReference,
  args: InterpreterArray,
  node: AstNode,
  settlement: SandboxPromise = new SandboxPromise(),
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  if (ref.name === "resolve") {
    // Promise.resolve of a promise is that promise (JS flattens); anything else is a
    // promise already fulfilled with the value.
    const value = args[0];
    return Effect.succeed(
      value instanceof SandboxPromise ? value : SandboxPromise.settled(Exit.succeed(value)),
    );
  }
  if (ref.name === "reject") {
    return Effect.sync(() => {
      assertBoundedCollectionSize(pendingWork(act) + 1, "Pending promises", node);
      const promise = SandboxPromise.settled(Exit.fail(new ProgramThrow(args[0])));
      act.execution.pendingSettlements.add(promise);
      return promise;
    });
  }

  const items = Array.isArray(args[0]) ? args[0] : spreadItems(args[0]);
  if (items === undefined) {
    throw new InterpreterRuntimeError(
      `Promise.${ref.name} expects an array of promises or plain values (e.g. Promise.${ref.name}(items.map((item) => tools.ns.tool(item)))).`,
      node,
    );
  }

  switch (ref.name) {
    case "any": {
      return Effect.gen(function* () {
        const errors: InterpreterArray = [];
        let remaining = items.length;
        const rejectAll = () =>
          settlement.settle(
            Exit.fail(
              new ProgramThrow(
                constructAggregateError([errors, "All promises were rejected"], node),
              ),
            ),
          );
        if (remaining === 0) rejectAll();
        for (const [index, item] of items.entries())
          observeInput(act, item, (raw) => {
            const exit = settledExit(item instanceof SandboxPromise ? item : undefined, raw, node);
            if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
              settlement.settle(exit);
              return;
            }
            errors[index] = caughtErrorValue(Cause.squash(exit.cause));
            remaining--;
            if (remaining === 0) rejectAll();
          });
        return yield* Effect.flatten(settlement.outcome());
      });
    }
    case "all": {
      // Every input is observed up front (Promise.all handles all of its members' failures,
      // as in JS), and each records its outcome as a turn job, so a later rejection does not
      // wait for an earlier unresolved input. Unrelated tools keep running.
      return Effect.gen(function* () {
        if (items.length === 0) return [];
        const values: InterpreterArray = [];
        let remaining = items.length;
        for (const [index, item] of items.entries())
          observeInput(act, item, (raw) => {
            const exit = settledExit(item instanceof SandboxPromise ? item : undefined, raw, node);
            if (Exit.isFailure(exit)) {
              settlement.settle(exit);
              return;
            }
            values[index] = exit.value;
            remaining -= 1;
            if (remaining === 0) settlement.settle(Exit.succeed(values));
          });
        return yield* Effect.flatten(settlement.outcome());
      });
    }
    case "allSettled": {
      return Effect.gen(function* () {
        const outcomes: InterpreterArray = [];
        let remaining = items.length;
        if (remaining === 0) return outcomes;
        for (const [index, item] of items.entries())
          observeInput(act, item, (exit) => {
            if (Exit.isSuccess(exit)) {
              outcomes[index] = Object.assign(makeInterpreterObject(), {
                status: "fulfilled",
                value: exit.value,
              });
            } else {
              const raceInterrupted =
                item instanceof SandboxPromise &&
                item.interrupted &&
                Cause.hasInterruptsOnly(exit.cause);
              if (Cause.hasInterruptsOnly(exit.cause) && !raceInterrupted) {
                settlement.settle(exit);
                return;
              }
              const thrown = raceInterrupted
                ? new InterpreterRuntimeError(
                    "This tool call was interrupted because another value settled a Promise.race first.",
                    node,
                  )
                : Cause.squash(exit.cause);
              outcomes[index] = Object.assign(makeInterpreterObject(), {
                status: "rejected",
                reason: caughtErrorValue(thrown),
              });
            }
            remaining -= 1;
            if (remaining === 0) settlement.settle(Exit.succeed(outcomes));
          });
        return yield* Effect.flatten(settlement.outcome());
      });
    }
    case "race": {
      if (items.length === 0) {
        throw new InterpreterRuntimeError(
          "Promise.race([]) would never settle; provide at least one promise or value.",
          node,
        );
      }
      return Effect.gen(function* () {
        // The first input to settle (fulfilled or rejected) wins, and the race settles
        // inside that input's job, before fiber cleanup could reorder two identical races.
        // Losing in-flight calls are then interrupted.
        let winner: number | undefined;
        for (const [index, item] of items.entries())
          observeInput(act, item, (exit) => {
            if (winner !== undefined) return;
            winner = index;
            settlement.settle(
              settledExit(item instanceof SandboxPromise ? item : undefined, exit, node),
            );
          });
        const outcome = yield* settlement.outcome();
        const winningItem = winner === undefined ? undefined : items[winner];
        yield* Effect.forEach(
          items.filter(
            (item): item is SandboxPromise =>
              item !== winningItem && item instanceof SandboxPromise,
          ),
          (item) => interruptPromise(act, item, true),
          { concurrency: "unbounded", discard: true },
        );
        return yield* outcome;
      });
    }
  }
}
