import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { RuntimeFailure } from "../failure.js";
import { ToolRuntime } from "../tool-runtime.js";
import { SandboxPromise } from "../values.js";
import { assertBoundedCollectionSize, ExecutionDeadline } from "./confinement.js";
import { GuestTurns } from "./guest-turns.js";
import { hoistVarDeclarations, predeclareLexicals } from "./scope.js";
import {
  type AstNode,
  type AstPropertyValue,
  type Binding,
  type InterpreterArray,
  InterpreterRuntimeError,
  type InterpreterValue,
  type ProgramNode,
  type StatementResult,
} from "./model.js";
import { normalizeError, type PromiseOwners } from "./runtime.js";
export interface ExecutionHost<R> {
  callDepth: number;
  currentScope(): Map<string, Binding>;
  functionScope: Map<string, Binding> | undefined;
  callPermits: Semaphore.Semaphore;
  deadline: ExecutionDeadline;
  drainPendingSettlements(): Effect.Effect<void, RuntimeFailure, never>;
  evaluateStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R>;
  execution: {
    nextToolCallLifecycleId: number;
    activePromises: number;
    scope: Scope.Scope;
    turns: GuestTurns;
    interrupting: Set<SandboxPromise>;
  };
  hoistFunctions(statements: Array<AstPropertyValue>): void;
  interruptPromise(promise: SandboxPromise, raceInterrupted: boolean): Effect.Effect<void>;
  invokeTool: (
    path: ReadonlyArray<string>,
    args: InterpreterArray,
    lifecycleId?: number,
  ) => Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  lastValue: InterpreterValue;
  observePromise(
    promise: SandboxPromise,
  ): Effect.Effect<Exit.Exit<InterpreterValue, RuntimeFailure>>;
  onToolCallLifecycle:
    | ((event: ToolRuntime.ToolCallLifecycleEvent) => Effect.Effect<void, never, R>)
    | undefined;
  owners: PromiseOwners;
  pendingSettlements: Set<SandboxPromise>;
  popScope(): void;
  promiseSettlement(
    promise: SandboxPromise,
  ): Effect.Effect<Exit.Exit<InterpreterValue, RuntimeFailure>>;
  pushScope(): void;
  releaseTurn(): Effect.Effect<void>;
  settlePromise(
    promise: SandboxPromise,
    node?: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, never>;
  startPromise(
    work: Effect.Effect<InterpreterValue, RuntimeFailure, R>,
    descendants?: Set<SandboxPromise>,
    settlement?: InterpreterValue,
  ): Effect.Effect<SandboxPromise, never, R>;
  turn: { held: boolean };
  unwrapPromiseExit(
    promise: SandboxPromise | undefined,
    exit: Exit.Exit<InterpreterValue, RuntimeFailure>,
    node?: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure>;
}

export function run<R>(
  this: ExecutionHost<R>,
  program: ProgramNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  // Run the program body in its own module scope on top of the builtin global scope, so
  // top-level declarations (`let undefined = 5`, `const Object = ...`) shadow builtins like
  // JS module scope, instead of colliding with the seeded globals.
  this.pushScope();
  return Effect.gen({ self: this }, function* () {
    yield* this.execution.turns.take(this.turn);
    this.functionScope = this.currentScope();
    predeclareLexicals(this.functionScope, program.body);
    hoistVarDeclarations(this.functionScope, program.body);
    this.hoistFunctions(program.body);
    let value: InterpreterValue = undefined;
    let returned = false;
    for (const statement of program.body) {
      const result = yield* this.evaluateStatement(statement);

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
        this.lastValue = result.value;
      }
    }
    if (!returned) value = this.lastValue;

    // The program body runs inside an implicit async function, so a returned promise
    // resolves before crossing the data boundary - `return tools.ns.tool(...)` works
    // without an explicit await, exactly as in JS.
    yield* this.releaseTurn();
    if (value instanceof SandboxPromise) value = yield* this.settlePromise(value);
    yield* this.drainPendingSettlements();
    return value;
  }).pipe(
    Effect.onExit((exit) => Scope.close(this.execution.scope, exit)),
    Effect.ensuring(this.releaseTurn()),
    Effect.ensuring(Effect.sync(() => this.popScope())),
  );
}

export function releaseTurn<R>(this: ExecutionHost<R>): Effect.Effect<void> {
  return Effect.suspend(() => {
    if (!this.turn.held) return Effect.void;
    this.turn.held = false;
    return this.execution.turns.release();
  });
}

export function startPromise<R>(
  this: ExecutionHost<R>,
  work: Effect.Effect<InterpreterValue, RuntimeFailure, R>,
  descendants?: Set<SandboxPromise>,
  settlement = Deferred.makeUnsafe<InterpreterValue, RuntimeFailure>(),
): Effect.Effect<SandboxPromise, never, R> {
  // Admission and observer installation are atomic with respect to cancellation. The
  // child work itself remains interruptible, including its synchronous guest prefix.
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen({ self: this }, function* () {
      assertBoundedCollectionSize(
        this.execution.activePromises + this.pendingSettlements.size + 1,
        "Pending promises",
      );
      this.execution.activePromises++;
      let ownerPromise: SandboxPromise | undefined;
      const owned =
        descendants === undefined
          ? work
          : work.pipe(
              Effect.onInterrupt(() =>
                Effect.forEach(
                  descendants,
                  (child) => this.interruptPromise(child, ownerPromise?.interrupted === true),
                  { discard: true },
                ),
              ),
            );
      const fiber = yield* Effect.forkIn(
        restore(owned.pipe(Effect.onExit((exit) => Deferred.done(settlement, exit)))),
        this.execution.scope,
        {
          startImmediately: true,
        },
      );
      const promise = new SandboxPromise(fiber, undefined, descendants, settlement);
      ownerPromise = promise;
      for (const owner of this.owners) owner.add(promise);
      this.pendingSettlements.add(promise);
      fiber.addObserver((exit) => {
        this.execution.activePromises--;
        for (const owner of this.owners) owner.delete(promise);
        // Keep only live work and unobserved failures, not every completed invocation.
        if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
          this.pendingSettlements.delete(promise);
        }
      });
      return promise;
    }),
  );
}

export function interruptPromise<R>(
  this: ExecutionHost<R>,
  promise: SandboxPromise,
  raceInterrupted: boolean,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    // Cancelling an ancestor would cancel this race itself and form an interruption
    // wait cycle. Cross-linked sibling races likewise must not re-enter cancellation.
    if (
      (raceInterrupted &&
        promise.descendants !== undefined &&
        this.owners.some((owner) => owner === promise.descendants)) ||
      this.execution.interrupting.has(promise)
    )
      return Effect.void;
    this.execution.interrupting.add(promise);
    return Effect.gen({ self: this }, function* () {
      if (raceInterrupted) promise.interrupted = true;
      if (promise.fiber !== undefined) yield* Fiber.interrupt(promise.fiber);
      // Completed losing activations can still own live descendants.
      for (const child of promise.descendants ?? [])
        yield* this.interruptPromise(child, raceInterrupted);
    }).pipe(Effect.ensuring(Effect.sync(() => this.execution.interrupting.delete(promise))));
  }).pipe(Effect.uninterruptible);
}

export function promiseReaction<R, A, B, Requirements = never>(
  this: ExecutionHost<R>,
  settlement: Effect.Effect<A, RuntimeFailure>,
  reaction: (value: A) => Effect.Effect<B, RuntimeFailure, Requirements>,
): Effect.Effect<B, RuntimeFailure, Requirements> {
  return Effect.flatMap(Effect.exit(settlement), (exit) => {
    if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
      return Effect.failCause(exit.cause);
    return this.execution.turns.withPermit(
      Exit.isSuccess(exit)
        ? Effect.suspend(() => {
            this.callDepth = 0;
            return reaction(exit.value);
          })
        : Effect.failCause(exit.cause),
    );
  });
}

export function drainPendingSettlements<R>(
  this: ExecutionHost<R>,
): Effect.Effect<void, RuntimeFailure, never> {
  return Effect.gen({ self: this }, function* () {
    // Keep failures in the bounded ledger until continuations have had a chance to
    // observe them. A later async turn can legitimately attach a rejection handler.
    const failures = new Set<SandboxPromise>();
    while (true) {
      const batch = Array.from(this.pendingSettlements).filter((promise) => !failures.has(promise));
      if (batch.length === 0) break;
      for (const promise of batch) {
        this.deadline.check();
        if (!this.pendingSettlements.has(promise)) continue;
        const exit = yield* this.promiseSettlement(promise);
        if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause))
          this.pendingSettlements.delete(promise);
        else failures.add(promise);
      }
    }
    for (const promise of failures) {
      if (!this.pendingSettlements.has(promise)) continue;
      const exit = yield* this.promiseSettlement(promise);
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
  this: ExecutionHost<R>,
  path: ReadonlyArray<string>,
  args: InterpreterArray,
): Effect.Effect<SandboxPromise, never, R> {
  const id = this.execution.nextToolCallLifecycleId++;
  const name = path.join(".");
  const emit = (event: ToolRuntime.ToolCallLifecycleEvent): Effect.Effect<void, never, R> =>
    this.onToolCallLifecycle?.(event) ?? Effect.void;
  const lifecycle = Effect.uninterruptibleMask((restore) =>
    Effect.gen({ self: this }, function* () {
      const queuedAt = yield* Clock.currentTimeMillis;
      yield* emit({ id, name, status: "queued" });
      let startedAt = queuedAt;
      let started = false;
      const invoked = this.callPermits.withPermit(
        Effect.gen({ self: this }, function* () {
          // Confinement: a queued call can wait for a permit past the cooperative deadline
          // while no guest step runs. Recheck after admission so expired work settles as a
          // failed, never-started call before running observation or host dispatch.
          this.deadline.check();
          startedAt = yield* Clock.currentTimeMillis;
          started = true;
          yield* emit({
            id,
            name,
            status: "running",
            queueDurationMs: Math.max(0, startedAt - queuedAt),
          });
          return yield* restore(
            Effect.suspend(() =>
              this.invokeTool(path, args, this.onToolCallLifecycle === undefined ? undefined : id),
            ),
          );
        }),
      );
      const exit = yield* Effect.exit(restore(invoked));
      const endedAt = yield* Clock.currentTimeMillis;
      const queueDurationMs = Math.max(0, startedAt - queuedAt);
      yield* emit({
        id,
        name,
        status: Exit.isSuccess(exit)
          ? "succeeded"
          : Cause.hasInterruptsOnly(exit.cause)
            ? "cancelled"
            : "failed",
        started,
        durationMs: Math.max(0, endedAt - queuedAt),
        queueDurationMs: started ? queueDurationMs : Math.max(0, endedAt - queuedAt),
      });
      if (Exit.isSuccess(exit)) return exit.value;
      return yield* Effect.failCause(exit.cause);
    }),
  );
  return this.startPromise(lifecycle);
}

export function observePromise<R>(
  this: ExecutionHost<R>,
  promise: SandboxPromise,
): Effect.Effect<Exit.Exit<InterpreterValue, RuntimeFailure>> {
  this.pendingSettlements.delete(promise);
  return this.promiseSettlement(promise);
}

export function promiseSettlement<R>(
  this: ExecutionHost<R>,
  promise: SandboxPromise,
): Effect.Effect<Exit.Exit<InterpreterValue, RuntimeFailure>> {
  if (promise.settlement !== undefined) return Effect.exit(Deferred.await(promise.settlement));
  if (promise.fiber !== undefined) return Fiber.await(promise.fiber);
  if (promise.immediate !== undefined) return Effect.exit(promise.immediate);
  throw new InterpreterRuntimeError("Promise has no settlement source.");
}

export function settlePromise<R>(
  this: ExecutionHost<R>,
  promise: SandboxPromise,
  node?: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, never> {
  return Effect.flatMap(this.observePromise(promise), (exit) =>
    this.unwrapPromiseExit(promise, exit, node),
  );
}

export function unwrapPromiseExit<R>(
  this: ExecutionHost<R>,
  promise: SandboxPromise | undefined,
  exit: Exit.Exit<InterpreterValue, RuntimeFailure>,
  node?: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure> {
  if (Exit.isSuccess(exit)) return Effect.succeed(exit.value);
  // A call Promise.race interrupted after losing settles as a catchable program failure;
  // any other interruption is execution teardown (timeout/host) and must keep propagating
  // as interruption rather than becoming program-visible data.
  if (promise?.interrupted === true && Cause.hasInterruptsOnly(exit.cause)) {
    return Effect.fail(
      new InterpreterRuntimeError(
        "This tool call was interrupted because another value settled a Promise.race first.",
        node,
      ),
    );
  }
  return Effect.failCause(exit.cause);
}
