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
import { boundedData, invokeCoercion } from "../stdlib/value.js";
import { coerceToString } from "./conversions.js";
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
  createErrorValue,
  attachErrorCause,
} from "../values.js";
import { assertBoundedCollectionSize } from "./confinement.js";
import { createGenerator, invokeGenerator } from "./generators.js";
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
  nativeIteratorHelpers,
  drainNativeIterator,
  makeNativeIterator,
} from "./iterator-protocol.js";
import { hoistVarDeclarations, patternNames } from "./scope.js";
import { invokeGroupBy } from "./group-by.js";
import { invokeJson } from "./json.js";
import {
  asNode,
  type AstNode,
  type AstPropertyValue,
  type Binding,
  GeneratorReference,
  getString,
  CodeModeFunction,
  CoercionFunction,
  ErrorConstructorReference,
  getArray,
  getNode,
  GlobalMethodReference,
  type InterpreterArray,
  InterpreterRuntimeError,
  type InterpreterValue,
  IntrinsicReference,
  isCallableReference,
  makeInterpreterObject,
  OptionalShortCircuit,
  PromiseMethodReference,
  UriFunction,
  ToolReference,
} from "./model.js";
import { toPropertyKey } from "./conversions.js";
import { hasObjectRuntimeType, runtimeTypeName } from "../runtime-values.js";
import { calleeText } from "./diagnostics.js";
import { declarePattern } from "./bindings.js";
import { invokeArrayFrom } from "./builtins.js";
import { invokeConsole, invokeObjectMethodOnTools } from "./console.js";
import { createToolCallPromise, releaseTurn, startPromise, resolvePromise } from "./execution.js";
import { evaluateExpression } from "./expressions.js";
import {
  invokeMapMethod,
  invokeSetMethod,
  invokeStringReplacer,
  invokeURLSearchParamsMethod,
} from "./iteration.js";
import { rejectCircularInsertion } from "./member-writes.js";
import { constructAggregateError, invokePromiseChain, invokePromiseMethod } from "./promises.js";
import { currentScope } from "./scope.js";
import { evaluateStatement } from "./statements.js";
import { type Activation, forkActivation } from "./activation.js";
import { invokeGlobalMethod } from "./globals.js";
import { invokeStringMethod } from "./string-operations.js";
import { invokeArrayMethod } from "./array-methods.js";

export function createFunction<R>(act: Activation<R>, node: AstNode): CodeModeFunction {
  const scopes = act.scopes.slice();
  // A named function expression sees its own name in a scope of its own, as in JS.
  const selfScope =
    node.type === "FunctionExpression" && node.id != null ? new Map<string, Binding>() : undefined;
  if (selfScope !== undefined) scopes.push(selfScope);
  const fn = new CodeModeFunction(
    getArray(node, "params").map((parameter, index) => asNode(parameter, `params[${index}]`)),
    getNode(node, "body"),
    scopes,
    node.async === true,
    node.generator === true,
  );
  if (selfScope !== undefined)
    selfScope.set(getString(getNode(node, "id"), "name"), {
      mutable: false,
      value: fn,
      initialized: true,
    });
  return fn;
}

export function evaluateCallExpression<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  const callee = getNode(node, "callee");
  const argNodes = getArray(node, "arguments");

  return Effect.gen(function* () {
    const callable = yield* evaluateExpression(act, callee);
    if (callable === OptionalShortCircuit) return OptionalShortCircuit;
    if ((callable === null || callable === undefined) && node.optional === true)
      return OptionalShortCircuit;

    const args = yield* evaluateCallArguments(act, argNodes);
    return yield* invokeCallable(act, callable, args, node, callee);
  });
}

export function invokeCallable<R>(
  act: Activation<R>,
  callable: InterpreterValue,
  args: InterpreterArray,
  node: AstNode,
  callee = node,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return Effect.gen(function* () {
    if (callable instanceof ToolReference) {
      if (callable.path.length === 0)
        throw new InterpreterRuntimeError("The tools root is not callable.", callee);
      // An un-awaited tool call is a first-class promise value; the call itself starts now.
      return yield* createToolCallPromise(act, callable.path, args, node);
    }
    if (callable instanceof PromiseMethodReference) {
      return yield* invokePromiseMethod(act, callable, args, node);
    }
    if (callable instanceof CodeModeFunction) {
      return yield* invokeFunction(act, callable, args);
    }
    if (callable instanceof IntrinsicReference) {
      return yield* invokeIntrinsic(act, callable, args, node);
    }
    if (callable instanceof GlobalMethodReference) {
      if (callable.namespace === "JSON")
        return yield* invokeJson(
          callable.name,
          args,
          node,
          (callback, _name, callbackNode) => (callbackArgs) =>
            invokeCallable(act, callback, callbackArgs, callbackNode),
          () => act.execution.deadline.check(),
        );
      if (
        (callable.namespace === "Object" || callable.namespace === "Map") &&
        callable.name === "groupBy"
      )
        return yield* invokeGroupBy(
          callable.namespace,
          args,
          node,
          (callback, callbackArgs) => invokeCallable(act, callback, callbackArgs, node),
          () => act.execution.deadline.check(),
          act,
        );
      if (callable.namespace === "console") return invokeConsole(act, callable.name, args, node);
      if (callable.namespace === "Array" && callable.name === "from")
        return yield* invokeArrayFrom(act, args, node);
      if (callable.namespace === "Object" && args[0] instanceof ToolReference) {
        // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
        return invokeObjectMethodOnTools(act, callable.name, args[0] as ToolReference, node);
      }
      if (callable.namespace === "Object" && callable.name === "assign") {
        return invokeObjectAssign(args, node, (target, key, value) => {
          // Object.assign already checks keys and counts growth incrementally. Re-entering
          // ordinary assignment would enumerate the growing target for every insertion.
          rejectCircularInsertion(target, value, "Object.assign result", node);
          if (Array.isArray(target)) target[Number(key)] = value;
          else target[key] = value;
        });
      }
      if (
        callable.namespace === "Object" &&
        callable.name === "fromEntries" &&
        isNativeIterator(args[0])
      )
        args[0] = drainNativeIterator(args[0], node);
      if (
        callable.namespace === "Object" &&
        callable.name === "fromEntries" &&
        hasCustomSyncIterator(args[0])
      ) {
        const host = forkActivation(act);
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
      // Object helpers are shallow and bound their own sizes; members keep their identity.
      if (callable.namespace === "Object") return invokeObjectMethod(callable.name, args, node);
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
        args[0] = yield* materializeIterable(
          forkActivation(act),
          args[0],
          node,
          "AggregateError errors",
        );
        return constructAggregateError(args, node);
      }
      const error = createErrorValue(
        callable.name,
        args[0] === undefined ? "" : coerceToString(args[0]),
      );
      attachErrorCause(error, args[1]);
      return error;
    }
    throw new InterpreterRuntimeError(
      `${calleeText(callee)} is not a function${
        callable === undefined ? "" : ` (it is ${describeValue(callable)})`
      }. Only functions, tools, and the supported built-in methods can be called in CodeMode.`,
      callee,
    ).as("TypeError");
  });
}

const describeValue = (value: InterpreterValue): string => {
  if (value === null) return "null";
  if (Predicate.isString(value))
    return `the string ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)}`;
  if (Predicate.isNumber(value) || Predicate.isBoolean(value))
    return `the ${runtimeTypeName(value)} ${String(value)}`;
  return Array.isArray(value)
    ? "an array"
    : `a${runtimeTypeName(value) === "object" ? "n" : ""} ${runtimeTypeName(value)}`;
};

export function evaluateCallArguments<R>(
  act: Activation<R>,
  argNodes: Array<AstPropertyValue>,
): Effect.Effect<InterpreterArray, RuntimeFailure, R> {
  return Effect.gen(function* () {
    const args: InterpreterArray = [];
    for (const [index, arg] of argNodes.entries()) {
      const argNode = asNode(arg, `arguments[${index}]`);
      if (argNode.type === "SpreadElement") {
        const spread = yield* evaluateExpression(act, getNode(argNode, "argument"));
        const items = yield* materializeIterable(
          forkActivation(act),
          spread,
          argNode,
          "Spread arguments",
        );
        assertBoundedCollectionSize(args.length + items.length, "Spread arguments", argNode);
        args.push(...items);
      } else {
        args.push(yield* evaluateExpression(act, argNode));
      }
    }
    return args;
  });
}

export function invokeFunction<R>(
  act: Activation<R>,
  fn: CodeModeFunction,
  args: InterpreterArray,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return Effect.gen(function* () {
    const activation = forkActivation(act);
    if (fn.generator) {
      activation.callDepth = act.execution.recursion.next(act.callDepth, fn.body);
      yield* prepareFunction(activation, fn, args);
      return createGenerator(activation, fn, evaluatePreparedFunction(activation, fn));
    }
    if (!fn.async) return yield* evaluateFunction(activation, fn, args);
    const boundary = Deferred.makeUnsafe<void>();
    const descendants = new Set<SandboxPromise>();
    activation.firstBoundary = boundary;
    activation.turn = { held: false };
    activation.owners = [...act.owners, descendants];
    const promise = new SandboxPromise(descendants);
    let adopting = false;
    const work = Effect.gen(function* () {
      const result = yield* evaluateFunction(activation, fn, args).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) || !(exit.value instanceof SandboxPromise)
            ? Effect.sync(() => promise.settle(exit))
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
      // Queue adoption before releasing the function's current turn. Its job likewise
      // registers the follow-up reaction before a later adoption can overtake it.
      resolvePromise(activation, promise, Exit.succeed(result));
      yield* releaseTurn(activation);
      yield* Deferred.succeed(boundary, undefined);
      return yield* Effect.flatten(promise.outcome());
    }).pipe(
      Effect.ensuring(releaseTurn(activation)),
      Effect.ensuring(Deferred.succeed(boundary, undefined)),
    );
    yield* startPromise(act, work, descendants, promise);
    yield* Deferred.await(boundary);
    // An async body with no await/adoption fulfills or rejects before returning to its
    // caller. Wait for fiber bookkeeping, but do not mark that rejection as observed.
    if (!adopting && activation.firstBoundary !== undefined && promise.fiber !== undefined)
      yield* Fiber.await(promise.fiber);
    return promise;
  });
}

export function evaluateFunction<R>(
  act: Activation<R>,
  fn: CodeModeFunction,
  args: InterpreterArray,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return Effect.suspend(() => {
    const savedDepth = act.callDepth;
    act.callDepth = act.execution.recursion.next(savedDepth, fn.body);
    const savedScopes = act.scopes;
    const savedFunctionScope = act.functionScope;
    const run = Effect.andThen(prepareFunction(act, fn, args), evaluatePreparedFunction(act, fn));
    return run.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          act.callDepth = savedDepth;
          act.scopes = savedScopes;
          act.functionScope = savedFunctionScope;
        }),
      ),
    );
  });
}

function prepareFunction<R>(
  host: Activation<R>,
  fn: CodeModeFunction,
  args: InterpreterArray,
): Effect.Effect<void, RuntimeFailure, R> {
  return Effect.gen(function* () {
    host.scopes = [...fn.capturedScopes, new Map<string, Binding>()];
    // Default initializers see every parameter's TDZ slot, not an outer binding.
    const paramScope = currentScope(host);
    for (const parameter of fn.parameters) {
      for (const name of patternNames(parameter))
        paramScope.set(name, { mutable: true, value: undefined, initialized: false });
    }
    for (const [index, parameter] of fn.parameters.entries()) {
      if (parameter.type === "RestElement") {
        yield* declarePattern(
          host,
          getNode(parameter, "argument"),
          args.slice(index),
          true,
          parameter,
        );
        break;
      }
      yield* declarePattern(host, parameter, args[index], true, parameter);
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
  host: Activation<R>,
  fn: CodeModeFunction,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return Effect.suspend(() =>
    fn.body.type === "BlockStatement"
      ? Effect.map(evaluateStatement(host, { ...fn.body, functionBody: true }), (result) =>
          result.kind === "return" || result.kind === "value" ? result.value : undefined,
        )
      : evaluateExpression(host, fn.body),
  );
}

export function invokeIntrinsic<R>(
  act: Activation<R>,
  ref: IntrinsicReference,
  args: InterpreterArray,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  if (ref.receiver instanceof SandboxBytes && ref.name !== "iterator")
    return Effect.succeed(invokeBytesMethod(ref, args, node));
  if (ref.receiver instanceof SandboxTextEncoder || ref.receiver instanceof SandboxTextDecoder)
    return Effect.succeed(invokeEncodingMethod(ref, args, node));
  if (ref.receiver instanceof GeneratorReference)
    return invokeGenerator(forkActivation(act), ref.receiver, ref.name, args, node);
  if (isNativeIterator(ref.receiver)) {
    if (!nativeIteratorHelpers.has(ref.name))
      return Effect.sync(() => invokeNativeIterator(ref, args, node));
    const receiver = ref.receiver;
    const name = ref.name;
    // The native sources are finite collections, so helpers drain eagerly and reuse the array
    // methods; the ones that return iterators in JS return a fresh iterator over the result.
    return Effect.suspend(() => {
      const items = drainNativeIterator(receiver, node);
      const asIterator = (values: InterpreterValue) =>
        makeNativeIterator((Array.isArray(values) ? values : []).values(), `Iterator.${name}`);
      switch (name) {
        case "toArray":
          return Effect.succeed(items);
        case "take":
        case "drop": {
          const count = args[0];
          if (!Predicate.isNumber(count) || Number.isNaN(count) || count < 0)
            throw new InterpreterRuntimeError(
              `Iterator.${name} expects a non-negative count.`,
              node,
            ).as("RangeError");
          return Effect.succeed(
            asIterator(name === "take" ? items.slice(0, count) : items.slice(count)),
          );
        }
        case "map":
        case "filter":
        case "flatMap":
          return Effect.map(invokeArrayMethod(act, items, name, args, node), asIterator);
        default:
          return invokeArrayMethod(act, items, name, args, node);
      }
    });
  }
  if (ref.name === "iterator") return Effect.sync(() => makeNativeIteratorFor(ref.receiver, node));
  if (ref.receiver instanceof SandboxPromise)
    return invokePromiseChain(act, ref.receiver, ref.name, args, node);
  if (Predicate.isString(ref.receiver)) {
    if ((ref.name === "replace" || ref.name === "replaceAll") && isCallableReference(args[1])) {
      return invokeStringReplacer(act, ref.receiver, ref.name, args, node);
    }
    return Effect.succeed(invokeStringMethod(ref.receiver, ref.name, args, node));
  }
  if (Predicate.isNumber(ref.receiver)) {
    return Effect.succeed(invokeNumberMethod(ref.receiver, ref.name, args, node));
  }
  if (Array.isArray(ref.receiver)) {
    return invokeArrayMethod(act, ref.receiver, ref.name, args, node);
  }
  if (ref.receiver instanceof SandboxDate) {
    return Effect.succeed(invokeDateMethod(ref.receiver, ref.name, node));
  }
  if (ref.receiver instanceof SandboxRegExp) {
    return Effect.succeed(invokeRegExpMethod(ref.receiver, ref.name, args, node));
  }
  if (ref.receiver instanceof SandboxMap) {
    return invokeMapMethod(act, ref.receiver, ref.name, args, node);
  }
  if (ref.receiver instanceof SandboxSet) {
    return invokeSetMethod(act, ref.receiver, ref.name, args, node);
  }
  if (ref.receiver instanceof SandboxURL) {
    return Effect.succeed(invokeURLMethod(ref.receiver, ref.name, node));
  }
  if (ref.receiver instanceof SandboxURLSearchParams) {
    return invokeURLSearchParamsMethod(act, ref.receiver, ref.name, args, node);
  }
  if (ref.receiver !== null && hasObjectRuntimeType(ref.receiver) && !Array.isArray(ref.receiver)) {
    const receiver = ref.receiver;
    if (ref.name === "toString") return Effect.sync(() => coerceToString(receiver));
    if (ref.name === "hasOwnProperty")
      return Effect.sync(() => Object.hasOwn(receiver, toPropertyKey(args[0], node)));
  }
  throw new InterpreterRuntimeError(`Method '${ref.name}' is not available in CodeMode.`, node);
}
