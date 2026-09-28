import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { RuntimeFailure } from "../failure.js";
import { SandboxPromise } from "../values.js";
import { assertBoundedCollectionSize, assertBoundedPendingWork } from "./confinement.js";
import {
  CodeModeFunction,
  GeneratorReference,
  GeneratorReturn,
  InterpreterRuntimeError,
  makeIteratorResult,
  ProgramThrow,
  type AstNode,
  type InterpreterArray,
  type InterpreterValue,
} from "./model.js";
import { acquireIterator, iteratorRequest } from "./iterator-protocol.js";
import {
  releaseTurn,
  settlePromise,
  startPromise,
  suspendAtAwait,
  takeTurn,
  endSynchronousPrefix,
} from "./execution.js";
import { type Activation, forkActivation } from "./activation.js";

type RequestKind = "next" | "return" | "throw";
interface Request {
  kind: RequestKind;
  value: InterpreterValue;
  reply: Deferred.Deferred<InterpreterValue, RuntimeFailure>;
}

interface QueuedRequest {
  ready: Deferred.Deferred<void>;
  previous: QueuedRequest | undefined;
  next: QueuedRequest | undefined;
}

// The body fiber is scope-owned but deliberately absent from the promise drain.
// Its ownership handle remains in activation descendant sets while suspended.
export class SandboxGenerator<R> extends GeneratorReference {
  readonly activation: Activation<R>;
  readonly body: Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  resume = Deferred.makeUnsafe<Request>();
  current: Request | undefined;
  handle: SandboxPromise | undefined;
  readonly ownerSets = new Set<Set<SandboxPromise>>();
  started = false;
  completed = false;
  running = false;
  queued = 0;
  tail: QueuedRequest | undefined;
  constructor(
    activation: Activation<R>,
    fn: CodeModeFunction,
    body: Effect.Effect<InterpreterValue, RuntimeFailure, R>,
  ) {
    super(fn.async);
    this.activation = activation;
    this.body = body;
  }
}

export function createGenerator<R>(
  activation: Activation<R>,
  fn: CodeModeFunction,
  body: Effect.Effect<InterpreterValue, RuntimeFailure, R>,
): GeneratorReference {
  return new SandboxGenerator(activation, fn, body);
}

function resumeValue(request: Request): Effect.Effect<InterpreterValue, RuntimeFailure> {
  if (request.kind === "throw") return Effect.fail(new ProgramThrow(request.value));
  if (request.kind === "return") return Effect.fail(new GeneratorReturn(request.value));
  return Effect.succeed(request.value);
}

function suspendYield<R>(
  generator: SandboxGenerator<R>,
  value: InterpreterValue,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return Effect.gen(function* () {
    const current = generator.current;
    if (current === undefined)
      throw new InterpreterRuntimeError("Generator has no active request.");
    if (generator.async) {
      // An async generator awaits each yielded value before handing it to the consumer.
      value = yield* suspendAtAwait(
        generator.activation,
        value instanceof SandboxPromise
          ? settlePromise(generator.activation, value)
          : Effect.succeed(value),
      );
      yield* releaseTurn(generator.activation);
    }
    yield* Deferred.succeed(current.reply, makeIteratorResult(value, false));
    const next = yield* Deferred.await(generator.resume);
    generator.resume = Deferred.makeUnsafe<Request>();
    generator.current = next;
    if (generator.async) {
      if (next.kind === "return") yield* endSynchronousPrefix(generator.activation);
      const settled =
        next.kind === "return" && next.value instanceof SandboxPromise
          ? yield* Effect.exit(settlePromise(generator.activation, next.value))
          : Exit.succeed(next.value);
      if (generator.activation.firstBoundary === undefined) yield* takeTurn(generator.activation);
      next.value = yield* settled;
    }
    return yield* resumeValue(next);
  });
}

function request<R>(
  caller: Activation<R>,
  generator: SandboxGenerator<R>,
  kind: RequestKind,
  value: InterpreterValue,
  boundary?: Deferred.Deferred<void>,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return Effect.gen(function* () {
    generator.activation.firstBoundary = boundary;
    if (generator.completed) {
      if (kind === "throw") return yield* Effect.fail(new ProgramThrow(value));
      if (kind === "return" && generator.async) {
        yield* endSynchronousPrefix(generator.activation);
        if (value instanceof SandboxPromise) value = yield* settlePromise(caller, value);
      }
      return makeIteratorResult(kind === "return" ? value : undefined, true);
    }
    if (generator.running)
      throw new InterpreterRuntimeError("Generator is already executing.").as("TypeError");
    // Queued async requests start on a later turn, not on the enqueueing stack.
    const depth =
      generator.async && boundary === undefined
        ? 0
        : caller.execution.recursion.next(caller.callDepth);
    generator.running = true;
    for (const owner of caller.owners) {
      generator.ownerSets.add(owner);
      if (generator.handle !== undefined) owner.add(generator.handle);
    }
    const incoming: Request = { kind, value, reply: Deferred.makeUnsafe() };
    const activation = generator.activation;
    activation.callDepth = depth;
    // A synchronous resume borrows, rather than releases and reacquires, this turn.
    activation.turn = generator.async ? { held: false } : caller.turn;
    const run = Effect.gen(function* () {
      if (!generator.started) {
        if (kind !== "next") {
          generator.completed = true;
          if (generator.async && kind === "return") {
            yield* endSynchronousPrefix(activation);
            if (incoming.value instanceof SandboxPromise)
              incoming.value = yield* settlePromise(activation, incoming.value);
          }
          return yield* resumeValue(incoming).pipe(
            Effect.catch((error) =>
              error instanceof GeneratorReturn
                ? Effect.succeed(makeIteratorResult(error.value, true))
                : Effect.fail(error),
            ),
          );
        }
        generator.started = true;
        generator.current = incoming;
        assertBoundedPendingWork(activation.execution.activePromises + 1, "Suspended generators");
        activation.execution.activePromises++;
        const descendants = new Set<SandboxPromise>();
        activation.owners = [...caller.owners, descendants];
        activation.generatorAsync = generator.async;
        activation.generatorYield = (yielded) => suspendYield(generator, yielded);
        const body = Effect.gen(function* () {
          if (generator.async && boundary === undefined) yield* takeTurn(activation);
          let result = yield* generator.body;
          if (generator.async) yield* endSynchronousPrefix(activation);
          if (generator.async && result instanceof SandboxPromise)
            result = yield* settlePromise(activation, result);
          return result;
        }).pipe(
          Effect.catch((error) =>
            error instanceof GeneratorReturn ? Effect.succeed(error.value) : Effect.fail(error),
          ),
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              generator.completed = true;
              activation.execution.activePromises--;
              if (generator.async) yield* endSynchronousPrefix(activation);
              const current = generator.current;
              if (current !== undefined) {
                if (Exit.isSuccess(exit))
                  yield* Deferred.succeed(current.reply, makeIteratorResult(exit.value, true));
                else yield* Deferred.failCause(current.reply, exit.cause);
              }
            }),
          ),
        );
        const fiber = yield* Effect.forkIn(body, activation.execution.scope, {
          startImmediately: true,
        });
        const handle = new SandboxPromise(descendants);
        handle.fiber = fiber;
        fiber.addObserver((exit) => handle.settle(exit));
        generator.handle = handle;
        for (const owner of generator.ownerSets) owner.add(handle);
        fiber.addObserver(() => {
          for (const owner of generator.ownerSets) owner.delete(handle);
          generator.ownerSets.clear();
        });
      } else {
        yield* Deferred.succeed(generator.resume, incoming);
      }
      const outcome = yield* Effect.exit(Deferred.await(incoming.reply));
      if (Exit.isFailure(outcome) && Cause.hasInterruptsOnly(outcome.cause))
        return yield* Effect.failCause(outcome.cause);
      return yield* outcome;
    });
    return yield* run.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          generator.running = false;
          activation.callDepth = 0;
        }),
      ),
    );
  });
}

export function invokeGenerator<R>(
  caller: Activation<R>,
  receiver: GeneratorReference,
  name: string,
  args: InterpreterArray,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  if (!(receiver instanceof SandboxGenerator))
    return Effect.fail(new InterpreterRuntimeError("Invalid generator receiver.", node));
  // SAFETY: A generator is created and consumed inside one execution with the same services.
  const generator = receiver as SandboxGenerator<R>;
  if (name === "iterator" || name === "asyncIterator") return Effect.succeed(receiver);
  if (name !== "next" && name !== "return" && name !== "throw")
    return Effect.fail(new InterpreterRuntimeError("Unknown generator method.", node));
  if (!generator.async) return request(caller, generator, name, args[0]);
  return Effect.suspend(() => {
    const boundary = generator.queued === 0 ? Deferred.makeUnsafe<void>() : undefined;
    assertBoundedCollectionSize(generator.queued + 1, "Queued async generator requests", node);
    generator.queued++;
    const queued: QueuedRequest = {
      ready: Deferred.makeUnsafe<void>(),
      previous: generator.tail,
      next: undefined,
    };
    if (queued.previous === undefined) Deferred.doneUnsafe(queued.ready, Exit.void);
    else queued.previous.next = queued;
    generator.tail = queued;
    const driver = forkActivation(caller);
    const descendants = new Set<SandboxPromise>();
    driver.owners = [...caller.owners, descendants];
    driver.turn = { held: false };
    const work = Effect.gen(function* () {
      yield* Deferred.await(queued.ready);
      return yield* request(driver, generator, name, args[0], boundary);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          generator.queued--;
          // Unlink cancelled waiters without releasing their successors ahead of
          // the active request. Cleanup never waits for another request to finish.
          if (queued.previous !== undefined) queued.previous.next = queued.next;
          if (queued.next !== undefined) {
            queued.next.previous = queued.previous;
            if (queued.previous === undefined) Deferred.doneUnsafe(queued.next.ready, Exit.void);
          } else generator.tail = queued.previous;
          queued.previous = undefined;
          queued.next = undefined;
          if (boundary !== undefined) Deferred.doneUnsafe(boundary, Exit.void);
        }),
      ),
    );
    return Effect.gen(function* () {
      const promise = yield* startPromise(caller, work, descendants);
      if (boundary !== undefined) yield* Deferred.await(boundary);
      return promise;
    });
  });
}

export function yieldDelegated<R>(
  activation: Activation<R>,
  value: InterpreterValue,
  node: AstNode,
  async = false,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return Effect.gen(function* () {
    const iterator = yield* acquireIterator(activation, value, node, async);
    let kind: RequestKind = "next";
    let input: InterpreterValue = undefined;
    while (true) {
      activation.execution.deadline.check(node);
      const result: { done: boolean; value: InterpreterValue } = yield* iteratorRequest(
        activation,
        iterator,
        kind,
        [input],
        node,
      );
      if (!result.done) assertBoundedCollectionSize(++iterator.visited, "Delegated yields", node);
      if (result.done) {
        if (kind === "return") return yield* Effect.fail(new GeneratorReturn(result.value));
        return result.value;
      }
      const resumed: Exit.Exit<InterpreterValue, RuntimeFailure> = yield* Effect.exit(
        yieldGenerator(activation, result.value, node),
      );
      if (Exit.isSuccess(resumed)) {
        kind = "next";
        input = resumed.value;
      } else {
        const error = Cause.squash(resumed.cause);
        if (error instanceof GeneratorReturn) {
          kind = "return";
          input = error.value;
        } else if (error instanceof ProgramThrow) {
          kind = "throw";
          input = error.value;
        } else return yield* Effect.failCause(resumed.cause);
      }
    }
  });
}

export function yieldGenerator<R>(
  activation: Activation<R>,
  value: InterpreterValue,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  if (activation.generatorYield === undefined)
    return Effect.fail(new InterpreterRuntimeError("yield outside generator.", node));
  return activation.generatorYield(value);
}

export function yieldValue<R>(
  act: Activation<R>,
  value: InterpreterValue,
  node: AstNode,
  delegate: boolean,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return delegate
    ? yieldDelegated(act, value, node, act.generatorAsync)
    : yieldGenerator(act, value, node);
}
