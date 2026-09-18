import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { RuntimeFailure } from "../failure.js";
import { hasObjectRuntimeType } from "../runtime-values.js";
import { uriArgument } from "../stdlib/url.js";
import { boundedData, coerceToString } from "../stdlib/value.js";
import { isBlockedMember } from "../tool-runtime.js";
import {
  SandboxMap,
  SandboxPromise,
  SandboxRegExp,
  SandboxSet,
  SandboxURLSearchParams,
} from "../values.js";
import {
  assertBoundedCollectionSize,
  assertBoundedStringLength,
  assertConfinedRegExpOperation,
  ExecutionDeadline,
  uriEncodedLengthUpperBound,
} from "./confinement.js";
import {
  type AstNode,
  type InterpreterArray,
  type InterpreterObject,
  InterpreterRuntimeError,
  type InterpreterValue,
  isCallableReference,
  makeInterpreterObject,
} from "./model.js";
import { invokeSetOperation } from "./set-operations.js";
export interface IterationHost<R> {
  applyCollectionCallback(
    callback: InterpreterValue,
    name: string,
    node: AstNode,
  ): (args: InterpreterArray) => Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  deadline: ExecutionDeadline;
  invokeCallable(
    callable: InterpreterValue,
    args: InterpreterArray,
    node: AstNode,
    callee?: InterpreterValue,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
}

export function invokeStringReplacer<R>(
  this: IterationHost<R>,
  value: string,
  name: "replace" | "replaceAll",
  args: InterpreterArray,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  const apply = this.applyCollectionCallback(args[1], `String.${name}`, node);
  const matches: Array<{
    readonly match: string;
    readonly offset: number;
    readonly args: InterpreterArray;
  }> = [];
  const collect = (...callbackArgs: InterpreterArray): string => {
    const match = callbackArgs[0];
    const groups = callbackArgs[callbackArgs.length - 1];
    const hasGroups = groups !== null && hasObjectRuntimeType(groups);
    const offset = callbackArgs[callbackArgs.length - (hasGroups ? 3 : 2)];
    if (!Predicate.isString(match) || !Predicate.isNumber(offset)) {
      throw new InterpreterRuntimeError(
        `String.${name} produced an invalid replacement match.`,
        node,
      );
    }
    if (hasGroups) {
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      const safeGroups: InterpreterObject = makeInterpreterObject();
      for (const [key, group] of Object.entries(groups)) {
        if (!isBlockedMember(key)) safeGroups[key] = group;
      }
      callbackArgs[callbackArgs.length - 1] = safeGroups;
    }
    matches.push({ match, offset, args: callbackArgs });
    return match;
  };

  const pattern = args[0];
  if (pattern instanceof SandboxRegExp) {
    if (name === "replaceAll" && !pattern.regex.global) {
      throw new InterpreterRuntimeError(
        `String.replaceAll requires a regular expression with the global (g) flag: write /${pattern.regex.source}/${pattern.regex.flags}g, or use String.replace to replace only the first match.`,
        node,
      );
    }
    assertConfinedRegExpOperation(pattern.regex, value, `String.${name}`, node);
    if (name === "replace") value.replace(pattern.regex, collect);
    else value.replaceAll(pattern.regex, collect);
  } else {
    if (!Predicate.isString(pattern)) {
      throw new InterpreterRuntimeError(`String.${name} expects argument 1 to be a string.`, node);
    }
    if (name === "replace") value.replace(pattern, collect);
    else value.replaceAll(pattern, collect);
  }

  return Effect.gen({ self: this }, function* () {
    const output: Array<string> = [];
    let total = 0;
    const push = (part: string): void => {
      total += part.length;
      // Confinement: the assembled result is charged incrementally, before join allocates.
      assertBoundedStringLength(total, `String.${name} result`, node);
      output.push(part);
    };
    let end = 0;
    for (const match of matches) {
      push(value.slice(end, match.offset));
      const replacement = yield* apply(match.args);
      // Replacers do not await callbacks. Coercion here is not a data-boundary escape
      // and does not observe a returned promise's rejection.
      push(
        replacement instanceof SandboxPromise
          ? "[object Promise]"
          : coerceToString(boundedData(replacement, `String.${name} replacer result`)),
      );
      end = match.offset + match.match.length;
    }
    push(value.slice(end));
    return boundedData(output.join(""), `String.${name} result`);
  });
}

export function applyCollectionCallback<R>(
  this: IterationHost<R>,
  callback: InterpreterValue,
  name: string,
  node: AstNode,
): (args: InterpreterArray) => Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  if (!isCallableReference(callback)) {
    throw new InterpreterRuntimeError(`${name} expects a function callback.`, node);
  }
  return (callbackArgs) =>
    Effect.suspend(() => {
      this.deadline.check(node);
      return this.invokeCallable(callback, callbackArgs, node);
    });
}

export function invokeMapMethod<R>(
  this: IterationHost<R>,
  target: SandboxMap,
  name: string,
  args: InterpreterArray,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  switch (name) {
    case "get":
      return Effect.succeed(target.map.get(args[0]));
    case "has":
      return Effect.succeed(target.map.has(args[0]));
    case "set":
      return Effect.sync(() => {
        if (!target.map.has(args[0])) {
          assertBoundedCollectionSize(target.map.size + 1, "Map.set", node);
        }
        target.map.set(args[0], args[1]);
        return target;
      });
    case "delete":
      return Effect.sync(() => target.map.delete(args[0]));
    case "clear":
      return Effect.sync(() => {
        target.map.clear();
        return undefined;
      });
    case "keys":
      return Effect.sync(() => Array.from(target.map.keys()));
    case "values":
      return Effect.sync(() => Array.from(target.map.values()));
    case "entries":
      return Effect.sync(() => Array.from(target.map.entries()));
    case "forEach": {
      const apply = this.applyCollectionCallback(args[0], "Map.forEach", node);
      return Effect.gen({ self: this }, function* () {
        let visited = 0;
        for (const [key, item] of target.map.entries()) {
          this.deadline.check(node);
          assertBoundedCollectionSize(++visited, "Map.forEach entries", node);
          yield* apply([item, key, target]);
        }
        return undefined;
      });
    }
    default:
      throw new InterpreterRuntimeError(`Map method '${name}' is not available in CodeMode.`, node);
  }
}

export function invokeSetMethod<R>(
  this: IterationHost<R>,
  target: SandboxSet,
  name: string,
  args: InterpreterArray,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  switch (name) {
    case "union":
    case "intersection":
    case "difference":
    case "symmetricDifference":
    case "isSubsetOf":
    case "isSupersetOf":
    case "isDisjointFrom":
      return Effect.sync(() => invokeSetOperation(target, name, args[0], this.deadline, node));
    case "has":
      return Effect.succeed(target.set.has(args[0]));
    case "add":
      return Effect.sync(() => {
        if (!target.set.has(args[0])) {
          assertBoundedCollectionSize(target.set.size + 1, "Set.add", node);
        }
        target.set.add(args[0]);
        return target;
      });
    case "delete":
      return Effect.sync(() => target.set.delete(args[0]));
    case "clear":
      return Effect.sync(() => {
        target.set.clear();
        return undefined;
      });
    case "keys":
    case "values":
      return Effect.sync(() => Array.from(target.set.values()));
    case "entries":
      return Effect.sync(() => Array.from(target.set.entries()));
    case "forEach": {
      const apply = this.applyCollectionCallback(args[0], "Set.forEach", node);
      return Effect.gen({ self: this }, function* () {
        let visited = 0;
        for (const item of target.set.values()) {
          this.deadline.check(node);
          assertBoundedCollectionSize(++visited, "Set.forEach entries", node);
          yield* apply([item, item, target]);
        }
        return undefined;
      });
    }
    default:
      throw new InterpreterRuntimeError(`Set method '${name}' is not available in CodeMode.`, node);
  }
}

export function invokeURLSearchParamsMethod<R>(
  this: IterationHost<R>,
  target: SandboxURLSearchParams,
  name: string,
  args: InterpreterArray,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  const arg = (index: number): string =>
    uriArgument(args[index], `URLSearchParams.${name} argument ${index + 1}`);
  const requireArgs = (count: number): void => {
    if (args.length < count) {
      throw new InterpreterRuntimeError(
        `URLSearchParams.${name} requires ${count} argument${count === 1 ? "" : "s"}.`,
        node,
      ).as("TypeError");
    }
  };
  switch (name) {
    case "append": {
      requireArgs(2);
      return Effect.sync(() => {
        assertBoundedCollectionSize(target.params.size + 1, "URLSearchParams.append", node);
        target.params.append(arg(0), arg(1));
        return undefined;
      });
    }
    case "delete": {
      requireArgs(1);
      return Effect.sync(() => {
        if (args[1] !== undefined) target.params.delete(arg(0), arg(1));
        else target.params.delete(arg(0));
        return undefined;
      });
    }
    case "get":
      requireArgs(1);
      return Effect.sync(() => target.params.get(arg(0)));
    case "getAll":
      requireArgs(1);
      return Effect.sync(() => {
        // Confinement preflight: the result is at most one entry per stored pair.
        assertBoundedCollectionSize(target.params.size, "URLSearchParams.getAll", node);
        return target.params.getAll(arg(0));
      });
    case "has":
      requireArgs(1);
      return Effect.sync(() =>
        args[1] !== undefined ? target.params.has(arg(0), arg(1)) : target.params.has(arg(0)),
      );
    case "set": {
      requireArgs(2);
      return Effect.sync(() => {
        const key = arg(0);
        if (!target.params.has(key)) {
          assertBoundedCollectionSize(target.params.size + 1, "URLSearchParams.set", node);
        }
        target.params.set(key, arg(1));
        return undefined;
      });
    }
    case "sort":
      return Effect.sync(() => {
        target.params.sort();
        return undefined;
      });
    // Confinement preflight on every materializing door: a URLSearchParams parsed from a
    // large admitted URL query can exceed the entry cap, so the projected count is charged
    // before Array.from allocates.
    case "keys":
      return Effect.sync(() => {
        assertBoundedCollectionSize(target.params.size, "URLSearchParams.keys", node);
        return Array.from(target.params.keys());
      });
    case "values":
      return Effect.sync(() => {
        assertBoundedCollectionSize(target.params.size, "URLSearchParams.values", node);
        return Array.from(target.params.values());
      });
    case "entries":
      return Effect.sync(() => {
        assertBoundedCollectionSize(target.params.size, "URLSearchParams.entries", node);
        return Array.from(target.params.entries());
      });
    case "toString":
      return Effect.sync(() => {
        // Confinement preflight: the serialized worst case (percent-encoding expansion)
        // is charged entry by entry before the native serializer materializes it.
        let projected = 0;
        for (const [key, value] of target.params.entries()) {
          projected += uriEncodedLengthUpperBound(key) + uriEncodedLengthUpperBound(value) + 2;
          assertBoundedStringLength(projected, "URLSearchParams.toString", node);
        }
        return target.params.toString();
      });
    case "forEach": {
      requireArgs(1);
      assertBoundedCollectionSize(target.params.size, "URLSearchParams.forEach", node);
      const apply = this.applyCollectionCallback(args[0], "URLSearchParams.forEach", node);
      return Effect.gen({ self: this }, function* () {
        let visited = 0;
        for (const [key, value] of target.params.entries()) {
          this.deadline.check(node);
          assertBoundedCollectionSize(++visited, "URLSearchParams.forEach entries", node);
          yield* apply([value, key, target]);
        }
        return undefined;
      });
    }
    default:
      throw new InterpreterRuntimeError(
        `URLSearchParams method '${name}' is not available in CodeMode.`,
        node,
      );
  }
}
