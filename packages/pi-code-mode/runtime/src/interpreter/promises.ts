import * as Predicate from "effect/Predicate";
import { materializeIterable, type IteratorHost } from "./iterator-protocol.js";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { RuntimeFailure } from "../failure.js";
import { hasObjectRuntimeType } from "../runtime-values.js";
import { spreadItems } from "../stdlib/collections.js";
import { coerceToString, createErrorValue } from "../stdlib/value.js";
import { ToolRuntime } from "../tool-runtime.js";
import { SandboxPromise } from "../values.js";
import { assertBoundedCollectionSize, ExecutionDeadline } from "./confinement.js";
import { GuestTurns } from "./guest-turns.js";
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
import { caughtErrorValue, Interpreter, type PromiseOwners } from "./runtime.js";
export interface PromisesHost<R> extends IteratorHost<R> {
  chainReaction(
    source: SandboxPromise,
    reaction: (
      exit: Exit.Exit<InterpreterValue, RuntimeFailure>,
    ) => Effect.Effect<InterpreterValue, RuntimeFailure, R>,
    descendants: Set<SandboxPromise>,
  ): Effect.Effect<SandboxPromise, never, R>;
  constructAggregateError(args: InterpreterArray, node: AstNode): InterpreterObject;
  deadline: ExecutionDeadline;
  evaluatePromiseMethod(
    ref: PromiseMethodReference,
    args: InterpreterArray,
    node: AstNode,
    settlement?: InterpreterValue,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  execution: {
    nextToolCallLifecycleId: number;
    activePromises: number;
    scope: Scope.Scope;
    turns: GuestTurns;
    interrupting: Set<SandboxPromise>;
  };
  interruptPromise(promise: SandboxPromise, raceInterrupted: boolean): Effect.Effect<void>;
  invokeTool: (
    path: ReadonlyArray<string>,
    args: InterpreterArray,
    lifecycleId?: number,
  ) => Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  logs: Array<string>;
  observePromise(
    promise: SandboxPromise,
  ): Effect.Effect<Exit.Exit<InterpreterValue, RuntimeFailure>>;
  onToolCallLifecycle:
    | ((event: ToolRuntime.ToolCallLifecycleEvent) => Effect.Effect<void, never, R>)
    | undefined;
  owners: PromiseOwners;
  pendingSettlements: Set<SandboxPromise>;
  promiseReaction<A, B, Requirements = never>(
    settlement: Effect.Effect<A, RuntimeFailure>,
    reaction: (value: A) => Effect.Effect<B, RuntimeFailure, Requirements>,
  ): Effect.Effect<B, RuntimeFailure, Requirements>;
  settlePromise(
    promise: SandboxPromise,
    node?: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, never>;
  startPromise(
    work: Effect.Effect<InterpreterValue, RuntimeFailure, R>,
    descendants?: Set<SandboxPromise>,
    settlement?: InterpreterValue,
  ): Effect.Effect<SandboxPromise, never, R>;
  toolKeys: (path: ReadonlyArray<string>) => ReadonlyArray<string>;
  unwrapPromiseExit(
    promise: SandboxPromise | undefined,
    exit: Exit.Exit<InterpreterValue, RuntimeFailure>,
    node?: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure>;
  fork(): Interpreter<R>;
}

export function constructAggregateError<R>(
  this: PromisesHost<R>,
  args: InterpreterArray,
  node: AstNode,
): InterpreterObject {
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
  const options = args[2];
  if (
    options !== null &&
    hasObjectRuntimeType(options) &&
    (Object.getPrototypeOf(options) === null ||
      Object.getPrototypeOf(options) === Object.prototype) &&
    Object.hasOwn(options, "cause")
  ) {
    // SAFETY: The closed guest domain and plain-object prototype check exclude wrappers.
    const cause = (options as InterpreterObject)["cause"];
    Object.defineProperty(result, "cause", { value: cause, writable: true, configurable: true });
  }
  return result;
}

export function chainReaction<R>(
  this: PromisesHost<R>,
  source: SandboxPromise,
  reaction: (
    exit: Exit.Exit<InterpreterValue, RuntimeFailure>,
  ) => Effect.Effect<InterpreterValue, RuntimeFailure, R>,
  descendants: Set<SandboxPromise>,
): Effect.Effect<SandboxPromise, never, R> {
  const observed = Effect.exit(this.settlePromise(source));
  const settlement = Deferred.makeUnsafe<InterpreterValue, RuntimeFailure>();
  let promise: SandboxPromise | undefined;
  const work = Effect.gen({ self: this }, function* () {
    yield* this.promiseReaction(observed, (exit) =>
      Effect.gen({ self: this }, function* () {
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
          return yield* Effect.failCause(exit.cause);
        const result = yield* Effect.exit(Effect.suspend(() => reaction(exit)));
        if (Exit.isFailure(result) || !(result.value instanceof SandboxPromise)) {
          yield* Deferred.done(settlement, result);
          return;
        }
        if (result.value === promise) {
          yield* Deferred.fail(
            settlement,
            new InterpreterRuntimeError("A promise cannot resolve to itself.").as("TypeError"),
          );
          return;
        }
        const adopted = Effect.exit(this.settlePromise(result.value));
        // Promise resolution queues an adoption job, which installs its reaction before
        // relinquishing that job's FIFO turn.
        yield* Effect.forkChild(
          Effect.gen({ self: this }, function* () {
            yield* this.execution.turns.withPermit(
              Effect.asVoid(
                Effect.forkChild(
                  this.promiseReaction(adopted, (value) => Deferred.done(settlement, value)),
                  { startImmediately: true },
                ),
              ),
            );
            yield* Effect.exit(Deferred.await(settlement));
          }),
          { startImmediately: true },
        );
      }),
    );
    return yield* Deferred.await(settlement);
  });
  return Effect.map(this.startPromise(work, descendants, settlement), (value) => {
    promise = value;
    return value;
  });
}

export function invokePromiseChain<R>(
  this: PromisesHost<R>,
  source: SandboxPromise,
  name: string,
  args: InterpreterArray,
  node: AstNode,
): Effect.Effect<SandboxPromise, never, R> {
  const activation = this.fork();
  const descendants = new Set<SandboxPromise>();
  activation.turn = { held: false };
  activation.owners = [...this.owners, descendants];
  return this.chainReaction(
    source,
    (exit) => {
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
        const result = yield* activation.invokeCallable(
          handler,
          name === "finally"
            ? []
            : [Exit.isSuccess(exit) ? exit.value : caughtErrorValue(Cause.squash(exit.cause))],
          node,
        );
        if (name !== "finally") return result;
        const cleanup =
          result instanceof SandboxPromise
            ? result
            : new SandboxPromise(undefined, Effect.succeed(result));
        return yield* activation.chainReaction(
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
  this: PromisesHost<R>,
  ref: PromiseMethodReference,
  args: InterpreterArray,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  if (ref.name === "resolve" || ref.name === "reject") {
    return this.evaluatePromiseMethod(ref, args, node);
  }
  return Effect.gen({ self: this }, function* () {
    const source = args[0];
    if (source == null || (!Predicate.isString(source) && !hasObjectRuntimeType(source)))
      return yield* this.startPromise(
        Effect.fail(
          new InterpreterRuntimeError(
            `Promise.${ref.name} expects an array or supported iterable of promises or plain values.`,
            node,
          ).as("TypeError"),
        ),
      );
    const consumed = yield* Effect.exit(
      materializeIterable(this, source, node, `Promise.${ref.name} inputs`),
    );
    if (Exit.isFailure(consumed)) return yield* this.startPromise(Effect.failCause(consumed.cause));
    const items = consumed.value;
    if (items?.length === 0 && (ref.name === "all" || ref.name === "allSettled"))
      return new SandboxPromise(undefined, Effect.succeed([]));
    const inputs = items === undefined ? args : [items];
    const settlement = Deferred.makeUnsafe<InterpreterValue, RuntimeFailure>();
    return yield* this.startPromise(
      Effect.suspend(() => this.evaluatePromiseMethod(ref, inputs, node, settlement)).pipe(
        Effect.onInterrupt(() =>
          Effect.forEach(
            items ?? [],
            (item) => {
              return item instanceof SandboxPromise
                ? this.interruptPromise(item, true)
                : Effect.void;
            },
            { discard: true },
          ),
        ),
      ),
      undefined,
      settlement,
    );
  });
}

export function evaluatePromiseMethod<R>(
  this: PromisesHost<R>,
  ref: PromiseMethodReference,
  args: InterpreterArray,
  node: AstNode,
  settlement = Deferred.makeUnsafe<InterpreterValue, RuntimeFailure>(),
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  if (ref.name === "resolve") {
    // Promise.resolve of a promise is that promise (JS flattens); anything else is a
    // promise already fulfilled with the value.
    const value = args[0];
    return Effect.succeed(
      value instanceof SandboxPromise
        ? value
        : new SandboxPromise(undefined, Effect.succeed(value)),
    );
  }
  if (ref.name === "reject") {
    return Effect.sync(() => {
      assertBoundedCollectionSize(
        this.execution.activePromises + this.pendingSettlements.size + 1,
        "Pending promises",
        node,
      );
      const promise = new SandboxPromise(undefined, Effect.fail(new ProgramThrow(args[0])));
      this.pendingSettlements.add(promise);
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
      const observations: Array<Effect.Effect<Exit.Exit<InterpreterValue, RuntimeFailure>>> =
        items.map((item) =>
          item instanceof SandboxPromise
            ? Effect.exit(this.settlePromise(item, node))
            : Effect.succeed(Exit.succeed(item)),
        );
      return Effect.gen({ self: this }, function* () {
        const errors: InterpreterArray = [];
        let remaining = observations.length;
        const reject = () =>
          Deferred.fail(
            settlement,
            new ProgramThrow(
              this.constructAggregateError([errors, "All promises were rejected"], node),
            ),
          );
        if (remaining === 0) yield* reject();
        for (const [index, observation] of observations.entries()) {
          yield* Effect.forkChild(
            this.promiseReaction(observation, (exit) => {
              if (Exit.isSuccess(exit)) return Deferred.succeed(settlement, exit.value);
              if (Cause.hasInterruptsOnly(exit.cause))
                return Deferred.failCause(settlement, exit.cause);
              errors[index] = caughtErrorValue(Cause.squash(exit.cause));
              remaining--;
              return remaining === 0 ? reject() : Effect.void;
            }),
            { startImmediately: true },
          );
        }
        return yield* Deferred.await(settlement);
      });
    }
    case "all": {
      // Mark every promise element observed up-front (Promise.all handles all of its
      // members' failures, as in JS). Observe concurrently so a later rejection does
      // not wait for an earlier unresolved input. Unrelated tools keep running.
      const settles = items.map((item) =>
        item instanceof SandboxPromise ? this.settlePromise(item, node) : Effect.succeed(item),
      );
      return Effect.gen({ self: this }, function* () {
        if (settles.length === 0) return [];
        const done = settlement;
        const values: InterpreterArray = [];
        let remaining = settles.length;
        for (const [index, settle] of settles.entries()) {
          yield* Effect.forkChild(
            this.promiseReaction(Effect.exit(settle), (exit) => {
              if (Exit.isFailure(exit)) return Deferred.failCause(done, exit.cause);
              values[index] = exit.value;
              remaining -= 1;
              return remaining === 0 ? Deferred.succeed(done, values) : Effect.void;
            }),
            { startImmediately: true },
          );
        }
        return yield* Deferred.await(done);
      });
    }
    case "allSettled": {
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      const observations = items.map((item) =>
        item instanceof SandboxPromise
          ? Effect.map(this.observePromise(item), (exit) => ({
              promise: item as SandboxPromise | undefined,
              exit,
            }))
          : Effect.succeed({
              promise: undefined as SandboxPromise | undefined,
              exit: Exit.succeed(item),
            }),
      );
      return Effect.gen({ self: this }, function* () {
        const outcomes: InterpreterArray = [];
        let remaining = observations.length;
        for (const [index, observation] of observations.entries()) {
          yield* Effect.forkChild(
            this.promiseReaction(observation, ({ exit, promise }) => {
              if (Exit.isSuccess(exit)) {
                outcomes[index] = Object.assign(makeInterpreterObject(), {
                  status: "fulfilled",
                  value: exit.value,
                });
              } else {
                const raceInterrupted =
                  promise?.interrupted === true && Cause.hasInterruptsOnly(exit.cause);
                if (Cause.hasInterruptsOnly(exit.cause) && !raceInterrupted)
                  return Deferred.failCause(settlement, exit.cause);
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
              return remaining === 0 ? Deferred.succeed(settlement, outcomes) : Effect.void;
            }),
            { startImmediately: true },
          );
        }
        return observations.length === 0 ? outcomes : yield* Deferred.await(settlement);
      });
    }
    case "race": {
      if (items.length === 0) {
        throw new InterpreterRuntimeError(
          "Promise.race([]) would never settle; provide at least one promise or value.",
          node,
        );
      }
      const observations = items.map((item, index) =>
        item instanceof SandboxPromise
          ? Effect.map(this.observePromise(item), (exit) => ({ index, exit }))
          : Effect.succeed({ index, exit: Exit.succeed(item) }),
      );
      return Effect.gen({ self: this }, function* () {
        // First settlement (fulfilled OR rejected) wins; the observations never fail, so
        // racing them yields exactly that. Losing in-flight calls are then interrupted.
        const done = Deferred.makeUnsafe<{
          index: number;
          exit: Exit.Exit<InterpreterValue, RuntimeFailure>;
        }>();
        // Attach reactions eagerly and publish logical settlement inside the reaction,
        // before Effect fiber cleanup can reorder two otherwise identical aggregates.
        let won = false;
        for (const observation of observations) {
          yield* Effect.forkChild(
            this.promiseReaction(observation, (value) => {
              if (won) return Effect.void;
              won = true;
              const input = items[value.index];
              return Effect.gen({ self: this }, function* () {
                const exit = yield* Effect.exit(
                  this.unwrapPromiseExit(
                    input instanceof SandboxPromise ? input : undefined,
                    value.exit,
                    node,
                  ),
                );
                yield* Deferred.done(settlement, exit);
                yield* Deferred.succeed(done, value);
              });
            }),
            { startImmediately: true },
          );
        }
        const winner = yield* Deferred.await(done);
        const winningItem = items[winner.index];
        for (const item of items) {
          if (item === winningItem || !(item instanceof SandboxPromise)) continue;
          yield* this.interruptPromise(item, true);
        }
        return yield* this.unwrapPromiseExit(
          winningItem instanceof SandboxPromise ? winningItem : undefined,
          winner.exit,
          node,
        );
      });
    }
  }
}
