import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Predicate from "effect/Predicate";
import type { RuntimeFailure } from "../failure.js";
import { invokeDateMethod } from "../stdlib/date.js";
import { invokeBytesMethod } from "../stdlib/bytes.js";
import { invokeEncodingMethod } from "../stdlib/encoding.js";
import { invokeNumberMethod } from "../stdlib/number.js";
import { invokeObjectAssign, invokeObjectMethod } from "../stdlib/object.js";
import { invokeRegExpMethod } from "../stdlib/regexp.js";
import { invokeUriFunction, invokeURLMethod } from "../stdlib/url.js";
import { boundedData, coerceToString, createErrorValue, invokeCoercion } from "../stdlib/value.js";
import { ToolReference, ToolRuntime } from "../tool-runtime.js";
import {
  SandboxDate,
  SandboxBytes,
  SandboxTextEncoder,
  SandboxTextDecoder,
  SandboxMap,
  SandboxPromise,
  SandboxRegExp,
  SandboxSet,
  SandboxURL,
  SandboxURLSearchParams,
} from "../values.js";
import { assertBoundedCollectionSize, ExecutionDeadline } from "./confinement.js";
import { createGenerator, invokeGenerator } from "./generators.js";
import { GeneratorReference } from "./model.js";
import type { RecursionBudget } from "./recursion.js";
import {
  acquireIterator,
  closeOnAbrupt,
  hasCustomSyncIterator,
  iteratorStep,
  preflightSource,
  invokeNativeIterator,
  isNativeIterator,
  makeNativeIteratorFor,
  materializeIterable,
} from "./iterator-protocol.js";
import { hoistVarDeclarations } from "./scope.js";
import { invokeGroupBy } from "./group-by.js";
import { invokeJson } from "./json.js";
import {
  asNode,
  type AstNode,
  type AstPropertyValue,
  type Binding,
  CodeModeFunction,
  CoercionFunction,
  ErrorConstructorReference,
  getArray,
  getNode,
  GlobalMethodReference,
  type InterpreterArray,
  type InterpreterObject,
  InterpreterRuntimeError,
  type InterpreterValue,
  IntrinsicReference,
  isCallableReference,
  type MemberReference,
  makeInterpreterObject,
  OptionalShortCircuit,
  PromiseMethodReference,
  type StatementResult,
  UriFunction,
} from "./model.js";
import {
  collectPatternNames,
  Interpreter,
  invokeGlobalMethod,
  invokeStringMethod,
  type PromiseOwners,
} from "./runtime.js";
export interface CallableHost<R> {
  callDepth: number;
  readonly recursion: RecursionBudget;
  rejectCircularInsertion(
    container: InterpreterObject | InterpreterArray,
    value: InterpreterValue,
    label: string,
    node: AstNode,
  ): void;
  assignToReference(
    reference: MemberReference,
    key: number | string,
    next: InterpreterValue,
    node: AstNode,
  ): void;
  constructAggregateError(args: InterpreterArray, node: AstNode): InterpreterObject;
  createToolCallPromise(
    path: ReadonlyArray<string>,
    args: InterpreterArray,
  ): Effect.Effect<SandboxPromise, never, R>;
  currentScope(): Map<string, Binding>;
  deadline: ExecutionDeadline;
  declarePattern(
    pattern: AstNode,
    value: InterpreterValue,
    mutable: boolean,
    node: AstNode,
  ): Effect.Effect<void, RuntimeFailure, R>;
  evaluateCallArguments(
    argNodes: Array<AstPropertyValue>,
  ): Effect.Effect<InterpreterArray, RuntimeFailure, R>;
  evaluateExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  evaluateStatement(node: AstNode): Effect.Effect<StatementResult, RuntimeFailure, R>;
  fork(): Interpreter<R>;
  invokeArrayFrom(
    args: InterpreterArray,
    node: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  invokeArrayMethod(
    target: InterpreterArray,
    name: string,
    args: InterpreterArray,
    node: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  invokeCallable(
    callable: InterpreterValue,
    args: InterpreterArray,
    node: AstNode,
    callee?: InterpreterValue,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  invokeConsole(name: string, args: InterpreterArray, node: AstNode): undefined;
  invokeFunction(
    fn: CodeModeFunction,
    args: InterpreterArray,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  invokeIntrinsic(
    ref: IntrinsicReference,
    args: InterpreterArray,
    node: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  invokeMapMethod(
    target: SandboxMap,
    name: string,
    args: InterpreterArray,
    node: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  invokeObjectMethodOnTools(name: string, ref: ToolReference, node: AstNode): InterpreterValue;
  invokePromiseChain(
    source: SandboxPromise,
    name: string,
    args: InterpreterArray,
    node: AstNode,
  ): Effect.Effect<SandboxPromise, never, R>;
  invokePromiseMethod(
    ref: PromiseMethodReference,
    args: InterpreterArray,
    node: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  invokeSetMethod(
    target: SandboxSet,
    name: string,
    args: InterpreterArray,
    node: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  invokeStringReplacer(
    value: string,
    name: "replace" | "replaceAll",
    args: InterpreterArray,
    node: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  invokeTool: (
    path: ReadonlyArray<string>,
    args: InterpreterArray,
    lifecycleId?: number,
  ) => Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  invokeURLSearchParamsMethod(
    target: SandboxURLSearchParams,
    name: string,
    args: InterpreterArray,
    node: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  logs: Array<string>;
  onToolCallLifecycle:
    | ((event: ToolRuntime.ToolCallLifecycleEvent) => Effect.Effect<void, never, R>)
    | undefined;
  owners: PromiseOwners;
  scopes: Array<Map<string, Binding>>;
  functionScope: Map<string, Binding> | undefined;
  startPromise(
    work: Effect.Effect<InterpreterValue, RuntimeFailure, R>,
    descendants?: Set<SandboxPromise>,
    settlement?: InterpreterValue,
  ): Effect.Effect<SandboxPromise, never, R>;
  toolKeys: (path: ReadonlyArray<string>) => ReadonlyArray<string>;
}

export function createFunction<R>(this: CallableHost<R>, node: AstNode): CodeModeFunction {
  return new CodeModeFunction(
    getArray(node, "params").map((parameter, index) => asNode(parameter, `params[${index}]`)),
    getNode(node, "body"),
    this.scopes.slice(),
    node.async === true,
    node.generator === true,
  );
}

export function evaluateCallExpression<R>(
  this: CallableHost<R>,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  const callee = getNode(node, "callee");
  const argNodes = getArray(node, "arguments");

  return Effect.gen({ self: this }, function* () {
    const callable = yield* this.evaluateExpression(callee);
    if (callable === OptionalShortCircuit) return OptionalShortCircuit;
    if ((callable === null || callable === undefined) && node.optional === true)
      return OptionalShortCircuit;

    const args = yield* this.evaluateCallArguments(argNodes);
    return yield* this.invokeCallable(callable, args, node, callee);
  });
}

export function invokeCallable<R>(
  this: CallableHost<R>,
  callable: InterpreterValue,
  args: InterpreterArray,
  node: AstNode,
  callee = node,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return Effect.gen({ self: this }, function* () {
    if (callable instanceof ToolReference) {
      if (callable.path.length === 0)
        throw new InterpreterRuntimeError("The tools root is not callable.", callee);
      // An un-awaited tool call is a first-class promise value; the call itself starts now.
      return yield* this.createToolCallPromise(callable.path, args);
    }
    if (callable instanceof PromiseMethodReference) {
      return yield* this.invokePromiseMethod(callable, args, node);
    }
    if (callable instanceof CodeModeFunction) {
      return yield* this.invokeFunction(callable, args);
    }
    if (callable instanceof IntrinsicReference) {
      return yield* this.invokeIntrinsic(callable, args, node);
    }
    if (callable instanceof GlobalMethodReference) {
      if (callable.namespace === "JSON")
        return yield* invokeJson(
          callable.name,
          args,
          node,
          (callback, _name, callbackNode) => (callbackArgs) =>
            this.invokeCallable(callback, callbackArgs, callbackNode),
          () => this.deadline.check(),
        );
      if (
        (callable.namespace === "Object" || callable.namespace === "Map") &&
        callable.name === "groupBy"
      )
        return yield* invokeGroupBy(
          callable.namespace,
          args,
          node,
          (callback, callbackArgs) => this.invokeCallable(callback, callbackArgs, node),
          () => this.deadline.check(),
        );
      if (callable.namespace === "console") return this.invokeConsole(callable.name, args, node);
      if (callable.namespace === "Array" && callable.name === "from")
        return yield* this.invokeArrayFrom(args, node);
      if (callable.namespace === "Object" && args[0] instanceof ToolReference) {
        // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
        return this.invokeObjectMethodOnTools(callable.name, args[0] as ToolReference, node);
      }
      if (callable.namespace === "Object" && callable.name === "assign") {
        return invokeObjectAssign(args, node, (target, key, value) => {
          // Object.assign already checks keys and counts growth incrementally. Re-entering
          // ordinary assignment would enumerate the growing target for every insertion.
          this.rejectCircularInsertion(target, value, "Object.assign result", node);
          if (Array.isArray(target)) target[Number(key)] = value;
          else target[key] = value;
        });
      }
      if (
        callable.namespace === "Object" &&
        callable.name === "fromEntries" &&
        hasCustomSyncIterator(args[0])
      ) {
        const host = this.fork();
        preflightSource(args[0], node, "Object.fromEntries input");
        const iterator = yield* acquireIterator(host, args[0], node);
        const out = makeInterpreterObject();
        let size = 0;
        while (true) {
          const next = yield* iteratorStep(host, iterator, node);
          if (next.done) return boundedData(out, "Object.fromEntries result");
          yield* closeOnAbrupt(
            host,
            iterator,
            node,
            Effect.sync(() => {
              const entry = invokeObjectMethod("fromEntries", [[next.value]], node);
              for (const key of Object.keys(entry)) {
                if (!Object.hasOwn(out, key))
                  assertBoundedCollectionSize(++size, "Object.fromEntries result", node);
                out[key] = entry[key];
              }
            }),
          );
        }
      }
      if (
        callable.namespace === "Object" &&
        (callable.name === "values" || callable.name === "entries")
      ) {
        const result = invokeObjectMethod(callable.name, args, node);
        boundedData(result, `Object.${callable.name} result`);
        return result;
      }
      return boundedData(
        invokeGlobalMethod(callable, args, node),
        `${callable.namespace}.${callable.name} result`,
      );
    }
    if (callable instanceof CoercionFunction) {
      return boundedData(invokeCoercion(callable, args, node), `${callable.name} result`);
    }
    if (callable instanceof UriFunction) {
      return invokeUriFunction(callable, args, node);
    }
    // `Error("msg")` without `new` constructs an error exactly like `new Error("msg")`, as in JS.
    if (callable instanceof ErrorConstructorReference) {
      if (callable.name === "AggregateError") {
        args[0] = yield* materializeIterable(this.fork(), args[0], node, "AggregateError errors");
        return this.constructAggregateError(args, node);
      }
      return createErrorValue(callable.name, args[0] === undefined ? "" : coerceToString(args[0]));
    }
    throw new InterpreterRuntimeError("Only tools are callable in CodeMode.", callee);
  });
}

export function evaluateCallArguments<R>(
  this: CallableHost<R>,
  argNodes: Array<AstPropertyValue>,
): Effect.Effect<InterpreterArray, RuntimeFailure, R> {
  return Effect.gen({ self: this }, function* () {
    const args: InterpreterArray = [];
    for (const [index, arg] of argNodes.entries()) {
      const argNode = asNode(arg, `arguments[${index}]`);
      if (argNode.type === "SpreadElement") {
        const spread = yield* this.evaluateExpression(getNode(argNode, "argument"));
        const items = yield* materializeIterable(this.fork(), spread, argNode, "Spread arguments");
        assertBoundedCollectionSize(args.length + items.length, "Spread arguments", argNode);
        args.push(...items);
      } else {
        args.push(yield* this.evaluateExpression(argNode));
      }
    }
    return args;
  });
}

export function invokeFunction<R>(
  this: CallableHost<R>,
  fn: CodeModeFunction,
  args: InterpreterArray,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return Effect.gen({ self: this }, function* () {
    const activation = this.fork();
    if (fn.generator) {
      activation.callDepth = this.recursion.next(this.callDepth, fn.body);
      yield* prepareFunction(activation, fn, args);
      return createGenerator(activation, fn, evaluatePreparedFunction(activation, fn));
    }
    if (!fn.async) return yield* activation.evaluateFunction(fn, args);
    const boundary = Deferred.makeUnsafe<void>();
    const descendants = new Set<SandboxPromise>();
    activation.firstBoundary = boundary;
    activation.turn = { held: false };
    activation.owners = [...this.owners, descendants];
    let promise: SandboxPromise | undefined;
    let adopting = false;
    const logicalSettlement = Deferred.makeUnsafe<InterpreterValue, RuntimeFailure>();
    const work = Effect.gen(function* () {
      const result = yield* activation
        .evaluateFunction(fn, args)
        .pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) || !(exit.value instanceof SandboxPromise)
              ? Deferred.done(logicalSettlement, exit)
              : Effect.void,
          ),
        );
      // Adoption is not part of the synchronous prefix and must not hold a guest turn.
      if (!(result instanceof SandboxPromise)) return result;
      if (result === promise)
        throw new InterpreterRuntimeError(
          "An async function cannot resolve to its own promise.",
        ).as("TypeError");
      adopting = true;
      const settlement = activation.settlePromise(result);
      // Queue adoption before releasing the function's current turn. Its job likewise
      // registers the follow-up reaction before a later adoption can overtake it.
      yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* activation.execution.turns.withPermit(
            Effect.asVoid(
              Effect.forkChild(
                activation.promiseReaction(Effect.exit(settlement), (exit) =>
                  Deferred.done(logicalSettlement, exit),
                ),
                { startImmediately: true },
              ),
            ),
          );
          // Keep the reaction child alive until adoption settles; its failure belongs to
          // the async function promise, not to this internal scheduling fiber.
          yield* Effect.exit(Deferred.await(logicalSettlement));
        }),
        { startImmediately: true },
      );
      yield* activation.releaseTurn();
      yield* Deferred.succeed(boundary, undefined);
      return yield* Deferred.await(logicalSettlement);
    }).pipe(
      Effect.ensuring(activation.releaseTurn()),
      Effect.ensuring(Deferred.succeed(boundary, undefined)),
    );
    promise = yield* this.startPromise(work, descendants, logicalSettlement);
    yield* Deferred.await(boundary);
    // An async body with no await/adoption fulfills or rejects before returning to its
    // caller. Wait for fiber bookkeeping, but do not mark that rejection as observed.
    if (!adopting && activation.firstBoundary !== undefined && promise.fiber !== undefined)
      yield* Fiber.await(promise.fiber);
    return promise;
  });
}

export function evaluateFunction<R>(
  this: CallableHost<R>,
  fn: CodeModeFunction,
  args: InterpreterArray,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return Effect.suspend(() => {
    const savedDepth = this.callDepth;
    this.callDepth = this.recursion.next(savedDepth, fn.body);
    const savedScopes = this.scopes;
    const savedFunctionScope = this.functionScope;
    const run = Effect.andThen(prepareFunction(this, fn, args), evaluatePreparedFunction(this, fn));
    return run.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          this.callDepth = savedDepth;
          this.scopes = savedScopes;
          this.functionScope = savedFunctionScope;
        }),
      ),
    );
  });
}

function prepareFunction<R>(
  host: CallableHost<R>,
  fn: CodeModeFunction,
  args: InterpreterArray,
): Effect.Effect<void, RuntimeFailure, R> {
  return Effect.gen(function* () {
    host.scopes = [...fn.capturedScopes, new Map<string, Binding>()];
    // Default initializers see every parameter's TDZ slot, not an outer binding.
    const paramScope = host.currentScope();
    for (const parameter of fn.parameters) {
      for (const name of collectPatternNames(parameter))
        paramScope.set(name, { mutable: true, value: undefined, initialized: false });
    }
    for (const [index, parameter] of fn.parameters.entries()) {
      if (parameter.type === "RestElement") {
        yield* host.declarePattern(
          getNode(parameter, "argument"),
          args.slice(index),
          true,
          parameter,
        );
        break;
      }
      yield* host.declarePattern(parameter, args[index], true, parameter);
    }
    if (fn.body.type === "BlockStatement") {
      const bodyScope = new Map<string, Binding>();
      hoistVarDeclarations(bodyScope, getArray(fn.body, "body"));
      for (const [name, binding] of bodyScope) {
        const parameter = paramScope.get(name);
        if (parameter !== undefined) binding.value = parameter.value;
      }
      host.scopes.push(bodyScope);
      host.functionScope = bodyScope;
    }
  });
}

function evaluatePreparedFunction<R>(
  host: CallableHost<R>,
  fn: CodeModeFunction,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return Effect.suspend(() =>
    fn.body.type === "BlockStatement"
      ? Effect.map(host.evaluateStatement({ ...fn.body, functionBody: true }), (result) =>
          result.kind === "return" || result.kind === "value" ? result.value : undefined,
        )
      : host.evaluateExpression(fn.body),
  );
}

export function invokeIntrinsic<R>(
  this: CallableHost<R>,
  ref: IntrinsicReference,
  args: InterpreterArray,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  if (ref.receiver instanceof SandboxBytes)
    return Effect.succeed(invokeBytesMethod(ref, args, node));
  if (ref.receiver instanceof SandboxTextEncoder || ref.receiver instanceof SandboxTextDecoder)
    return Effect.succeed(invokeEncodingMethod(ref, args, node));
  if (ref.receiver instanceof GeneratorReference)
    return invokeGenerator(this.fork(), ref.receiver, ref.name, args, node);
  if (isNativeIterator(ref.receiver))
    return Effect.sync(() => invokeNativeIterator(ref, args, node));
  if (ref.name === "iterator") return Effect.sync(() => makeNativeIteratorFor(ref.receiver, node));
  if (ref.receiver instanceof SandboxPromise)
    return this.invokePromiseChain(ref.receiver, ref.name, args, node);
  if (Predicate.isString(ref.receiver)) {
    if ((ref.name === "replace" || ref.name === "replaceAll") && isCallableReference(args[1])) {
      return this.invokeStringReplacer(ref.receiver, ref.name, args, node);
    }
    return Effect.succeed(invokeStringMethod(ref.receiver, ref.name, args, node));
  }
  if (Predicate.isNumber(ref.receiver)) {
    return Effect.succeed(invokeNumberMethod(ref.receiver, ref.name, args, node));
  }
  if (Array.isArray(ref.receiver)) {
    return this.invokeArrayMethod(ref.receiver, ref.name, args, node);
  }
  if (ref.receiver instanceof SandboxDate) {
    return Effect.succeed(invokeDateMethod(ref.receiver, ref.name, node));
  }
  if (ref.receiver instanceof SandboxRegExp) {
    return Effect.succeed(invokeRegExpMethod(ref.receiver, ref.name, args, node));
  }
  if (ref.receiver instanceof SandboxMap) {
    return this.invokeMapMethod(ref.receiver, ref.name, args, node);
  }
  if (ref.receiver instanceof SandboxSet) {
    return this.invokeSetMethod(ref.receiver, ref.name, args, node);
  }
  if (ref.receiver instanceof SandboxURL) {
    return Effect.succeed(invokeURLMethod(ref.receiver, ref.name, node));
  }
  if (ref.receiver instanceof SandboxURLSearchParams) {
    return this.invokeURLSearchParamsMethod(ref.receiver, ref.name, args, node);
  }
  throw new InterpreterRuntimeError(`Method '${ref.name}' is not available in CodeMode.`, node);
}
