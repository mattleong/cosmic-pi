import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { RuntimeFailure } from "../failure.js";
import { SandboxPromise } from "../values.js";
import { assertBoundedCollectionSize } from "./confinement.js";
import {
  CodeModeFunction,
  GeneratorReference,
  GeneratorReturn,
  InterpreterRuntimeError,
  ProgramThrow,
  type AstNode,
  type InterpreterArray,
  type InterpreterValue,
} from "./model.js";
import type { Interpreter } from "./runtime.js";
import { acquireIterator, iteratorRequest } from "./iterator-protocol.js";

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
  readonly activation: Interpreter<R>;
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
    activation: Interpreter<R>,
    fn: CodeModeFunction,
    body: Effect.Effect<InterpreterValue, RuntimeFailure, R>,
  ) {
    super(fn.async);
    this.activation = activation;
    this.body = body;
  }
}

export function createGenerator<R>(
  activation: Interpreter<R>,
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

function endPrefix<R>(activation: Interpreter<R>): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* activation.releaseTurn();
    const boundary = activation.firstBoundary;
    activation.firstBoundary = undefined;
    if (boundary !== undefined) yield* Deferred.succeed(boundary, undefined);
  });
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
      yield* endPrefix(generator.activation);
      const settled =
        value instanceof SandboxPromise
          ? yield* Effect.exit(generator.activation.settlePromise(value))
          : Exit.succeed(value);
      yield* generator.activation.execution.turns.take(generator.activation.turn);
      generator.activation.callDepth = 0;
      value = yield* settled;
      yield* generator.activation.releaseTurn();
    }
    yield* Deferred.succeed(current.reply, { value, done: false });
    const next = yield* Deferred.await(generator.resume);
    generator.resume = Deferred.makeUnsafe<Request>();
    generator.current = next;
    if (generator.async) {
      if (next.kind === "return") yield* endPrefix(generator.activation);
      const settled =
        next.kind === "return" && next.value instanceof SandboxPromise
          ? yield* Effect.exit(generator.activation.settlePromise(next.value))
          : Exit.succeed(next.value);
      if (generator.activation.firstBoundary === undefined) {
        yield* generator.activation.execution.turns.take(generator.activation.turn);
        generator.activation.callDepth = 0;
      }
      next.value = yield* settled;
    }
    return yield* resumeValue(next);
  });
}

function request<R>(
  caller: Interpreter<R>,
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
        yield* endPrefix(generator.activation);
        if (value instanceof SandboxPromise) value = yield* caller.settlePromise(value);
      }
      return { value: kind === "return" ? value : undefined, done: true };
    }
    if (generator.running)
      throw new InterpreterRuntimeError("Generator is already executing.").as("TypeError");
    // Queued async requests start on a later turn, not on the enqueueing stack.
    const depth =
      generator.async && boundary === undefined ? 0 : caller.recursion.next(caller.callDepth);
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
            yield* endPrefix(activation);
            if (incoming.value instanceof SandboxPromise)
              incoming.value = yield* activation.settlePromise(incoming.value);
          }
          return yield* resumeValue(incoming).pipe(
            Effect.catch((error) =>
              error instanceof GeneratorReturn
                ? Effect.succeed({ value: error.value, done: true })
                : Effect.fail(error),
            ),
          );
        }
        generator.started = true;
        generator.current = incoming;
        assertBoundedCollectionSize(
          activation.execution.activePromises + 1,
          "Suspended generators",
        );
        activation.execution.activePromises++;
        const descendants = new Set<SandboxPromise>();
        activation.owners = [...caller.owners, descendants];
        activation.generatorAsync = generator.async;
        activation.generatorYield = (yielded) => suspendYield(generator, yielded);
        const body = Effect.gen(function* () {
          if (generator.async && boundary === undefined) {
            yield* activation.execution.turns.take(activation.turn);
            activation.callDepth = 0;
          }
          let result = yield* generator.body;
          if (generator.async) yield* endPrefix(activation);
          if (generator.async && result instanceof SandboxPromise)
            result = yield* activation.settlePromise(result);
          return result;
        }).pipe(
          Effect.catch((error) =>
            error instanceof GeneratorReturn ? Effect.succeed(error.value) : Effect.fail(error),
          ),
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              generator.completed = true;
              activation.execution.activePromises--;
              if (generator.async) yield* endPrefix(activation);
              const current = generator.current;
              if (current !== undefined) {
                if (Exit.isSuccess(exit))
                  yield* Deferred.succeed(current.reply, { value: exit.value, done: true });
                else yield* Deferred.failCause(current.reply, exit.cause);
              }
            }),
          ),
        );
        const fiber = yield* Effect.forkIn(body, activation.execution.scope, {
          startImmediately: true,
        });
        const handle = new SandboxPromise(fiber, undefined, descendants);
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
  caller: Interpreter<R>,
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
    const driver = caller.fork();
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
      const promise = yield* caller.startPromise(work, descendants);
      if (boundary !== undefined) yield* Deferred.await(boundary);
      return promise;
    });
  });
}

export function yieldDelegated<R>(
  activation: Interpreter<R>,
  value: InterpreterValue,
  node: AstNode,
  async = false,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return Effect.gen(function* () {
    const iterator = yield* acquireIterator(activation, value, node, async);
    let kind: RequestKind = "next";
    let input: InterpreterValue = undefined;
    while (true) {
      activation.deadline.check(node);
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
  activation: Interpreter<R>,
  value: InterpreterValue,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  if (activation.generatorYield === undefined)
    return Effect.fail(new InterpreterRuntimeError("yield outside generator.", node));
  return activation.generatorYield(value);
}
