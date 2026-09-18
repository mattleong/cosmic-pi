import {
  acquireIterator,
  iteratorStep,
  closeOnAbrupt,
  hasSyncIterator,
  materializeIterable,
  type IteratorHost,
} from "./iterator-protocol.js";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { RuntimeFailure } from "../failure.js";
import { hasObjectRuntimeType, runtimeTypeName } from "../runtime-values.js";
import { constructBytes } from "../stdlib/bytes.js";
import { constructTextDecoder } from "../stdlib/encoding.js";
import { clipEpochMillis, epochFromLocalParts, epochNow } from "../stdlib/epoch.js";
import { escapeRegexHint, regexFailureReason } from "../stdlib/regexp.js";
import { uriArgument, urlArgument } from "../stdlib/url.js";
import {
  boundedData,
  coerceToNumber,
  coerceToString,
  createErrorValue,
  errorConstructors,
  valueConstructors,
} from "../stdlib/value.js";
import {
  isSandboxValue,
  SandboxBytes,
  SandboxTextEncoder,
  SandboxDate,
  SandboxMap,
  SandboxRegExp,
  SandboxSet,
  SandboxURL,
  SandboxURLSearchParams,
} from "../values.js";
import {
  assertBoundedCollectionSize,
  assertBoundedQueryPairs,
  assertBoundedUrlConstructionInputs,
  assertConfinedRegExp,
} from "./confinement.js";
import {
  asNode,
  type AstNode,
  type AstPropertyValue,
  getArray,
  getNode,
  getString,
  type InterpreterArray,
  type InterpreterObject,
  InterpreterRuntimeError,
  type InterpreterValue,
  supportedSyntaxMessage,
  unsupportedSyntax,
} from "./model.js";
export interface ConstructorsHost<R> extends IteratorHost<R> {
  constructAggregateError(args: InterpreterArray, node: AstNode): InterpreterObject;
  evaluateCallArguments(
    argNodes: Array<AstPropertyValue>,
  ): Effect.Effect<InterpreterArray, RuntimeFailure, R>;
  evaluateExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  constructDate(args: InterpreterArray): SandboxDate;
  constructRegExp(args: InterpreterArray, node: AstNode): SandboxRegExp;
  constructMap<InitInput>(init: InitInput, node: AstNode): SandboxMap;
  constructSet<InitInput>(init: InitInput, node: AstNode): SandboxSet;
  constructURL(args: InterpreterArray, node: AstNode): SandboxURL;
  constructURLSearchParams<InitInput>(init: InitInput, node: AstNode): SandboxURLSearchParams;
}
export function evaluateNewExpression<R>(
  this: ConstructorsHost<R>,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  const callee = getNode(node, "callee");
  if (callee.type !== "Identifier") {
    throw unsupportedSyntax("NewExpression", node);
  }
  const name = getString(callee, "name");
  const argNodes = getArray(node, "arguments");
  if (name === "Promise") {
    throw new InterpreterRuntimeError(
      "new Promise(...) is not supported in CodeMode; tool calls already return promises - call the tool and await the result.",
      node,
      "UnsupportedSyntax",
      [supportedSyntaxMessage],
    );
  }
  if (name === "Uint8Array" || name === "TextEncoder" || name === "TextDecoder") {
    return Effect.gen({ self: this }, function* () {
      const args = yield* this.evaluateCallArguments(argNodes);
      if (name === "TextEncoder") {
        if (args.length !== 0)
          throw new InterpreterRuntimeError("TextEncoder takes no options.", node).as("TypeError");
        return new SandboxTextEncoder();
      }
      if (name === "TextDecoder") return constructTextDecoder(args, node);
      if (args.length > 1)
        throw new InterpreterRuntimeError(
          "Uint8Array buffer/offset constructors are not supported.",
          node,
        ).as("TypeError");
      const source = args[0];
      return constructBytes(
        source !== undefined &&
          !Predicate.isNumber(source) &&
          !(source instanceof SandboxBytes) &&
          !Array.isArray(source)
          ? yield* materializeIterable(this, source, node, "Uint8Array constructor")
          : source,
        node,
      );
    });
  }
  if (errorConstructors.has(name)) {
    return Effect.gen({ self: this }, function* () {
      if (name === "AggregateError") {
        const args = yield* this.evaluateCallArguments(argNodes);
        args[0] = yield* materializeIterable(this, args[0], node, "AggregateError errors");
        return this.constructAggregateError(args, node);
      }
      const arg =
        argNodes.length > 0
          ? yield* this.evaluateExpression(asNode(argNodes[0], "arguments[0]"))
          : undefined;
      return createErrorValue(name, arg === undefined ? "" : coerceToString(arg));
    });
  }
  if (valueConstructors.has(name)) {
    return Effect.gen({ self: this }, function* () {
      const args = yield* this.evaluateCallArguments(argNodes);
      switch (name) {
        case "Date":
          return this.constructDate(args);
        case "RegExp":
          return this.constructRegExp(args, node);
        case "Map":
          return yield* constructCollection(this, args[0], node, true);
        case "Set":
          return yield* constructCollection(this, args[0], node, false);
        case "URL":
          return this.constructURL(args, node);
        default:
          return this.constructURLSearchParams(
            args[0] != null && !Predicate.isString(args[0]) && hasSyncIterator(args[0])
              ? yield* materializeIterable(this, args[0], node, "URLSearchParams")
              : args[0],
            node,
          );
      }
    });
  }
  throw unsupportedSyntax("NewExpression", node);
}
export function constructDate<R>(this: ConstructorsHost<R>, args: InterpreterArray): SandboxDate {
  if (args.length === 0) return new SandboxDate(epochNow());
  if (args.length === 1) {
    const arg = args[0];
    if (arg instanceof SandboxDate) return new SandboxDate(arg.time);
    if (Predicate.isNumber(arg)) return new SandboxDate(clipEpochMillis(arg));
    if (Predicate.isString(arg)) return new SandboxDate(Date.parse(arg));
    return new SandboxDate(Number.NaN);
  }
  // new Date(year, month, day?, hours?, ...) - local-time component form.
  return new SandboxDate(epochFromLocalParts(args.map((arg) => coerceToNumber(arg))));
}
export function constructRegExp<R>(
  this: ConstructorsHost<R>,
  args: InterpreterArray,
  node: AstNode,
): SandboxRegExp {
  const first = args[0];
  const pattern =
    first instanceof SandboxRegExp
      ? first.regex.source
      : first === undefined
        ? ""
        : coerceToString(first);
  const flagsArg = args[1];
  if (flagsArg !== undefined && !Predicate.isString(flagsArg)) {
    throw new InterpreterRuntimeError(
      `RegExp flags must be a string of flag characters (e.g. "g", "gi"), not ${flagsArg === null ? "null" : runtimeTypeName(flagsArg)}.`,
      node,
    );
  }
  const flags = flagsArg ?? (first instanceof SandboxRegExp ? first.regex.flags : "");
  try {
    const constructed = new SandboxRegExp(pattern, flags);
    // Confinement: reject unpreemptible backtracking constructions at construction time,
    // so the diagnostic points at the pattern instead of a later match operation.
    assertConfinedRegExp(constructed.regex, node);
    return constructed;
  } catch (error) {
    if (error instanceof InterpreterRuntimeError) throw error;
    // Say which part was rejected and how to fix it, instead of passing the engine
    // message through bare. A flags failure names the flags; a pattern failure gets the
    // escaping hint (the usual cause is an unescaped metacharacter in a built-up string).
    const reason = regexFailureReason(error);
    throw new InterpreterRuntimeError(
      /flag/i.test(reason)
        ? `new RegExp(...) received invalid flags ${JSON.stringify(flags)} (${reason}). Valid flags are d, g, i, m, s, u, v, and y.`
        : `new RegExp(...) received ${JSON.stringify(pattern)}, which is not a valid regular expression pattern (${reason}). ${escapeRegexHint}`,
      node,
    ).as("SyntaxError");
  }
}
export function constructMap<R, InitInput>(
  this: ConstructorsHost<R>,
  init: InitInput,
  node: AstNode,
): SandboxMap {
  const target = new SandboxMap();
  if (init === undefined || init === null) return target;
  if (init instanceof SandboxMap) {
    // Confinement preflight: charge the copy before materializing the entry array.
    assertBoundedCollectionSize(init.map.size, "new Map(...)", node);
  }
  const entries = Array.isArray(init)
    ? init
    : init instanceof SandboxMap
      ? Array.from(init.map.entries(), ([key, item]): InterpreterArray => [key, item])
      : undefined;
  if (entries === undefined) {
    throw new InterpreterRuntimeError(
      "new Map(...) expects an array of [key, value] pairs, a Map, or no argument.",
      node,
    );
  }
  for (const pair of entries) {
    if (!Array.isArray(pair)) {
      throw new InterpreterRuntimeError("new Map(...) expects [key, value] pairs.", node);
    }
    target.map.set(pair[0], pair[1]);
  }
  return target;
}
export function constructSet<R, InitInput>(
  this: ConstructorsHost<R>,
  init: InitInput,
  node: AstNode,
): SandboxSet {
  const target = new SandboxSet();
  if (init === undefined || init === null) return target;
  // Confinement preflight: charge the projected entry count before any native
  // materialization (a string of N code units expands to at most N entries).
  if (init instanceof SandboxSet) {
    assertBoundedCollectionSize(init.set.size, "new Set(...)", node);
  } else if (Predicate.isString(init)) {
    assertBoundedCollectionSize(init.length, "new Set(...)", node);
  }
  const items = Array.isArray(init)
    ? init
    : init instanceof SandboxSet
      ? Array.from(init.set.values())
      : Predicate.isString(init)
        ? Array.from(init)
        : undefined;
  if (items === undefined) {
    throw new InterpreterRuntimeError(
      "new Set(...) expects an array, Set, string, or no argument.",
      node,
    );
  }
  for (const item of items) target.set.add(item);
  assertBoundedCollectionSize(target.set.size, "new Set(...)", node);
  return target;
}
export function constructURL<R>(
  this: ConstructorsHost<R>,
  args: InterpreterArray,
  node: AstNode,
): SandboxURL {
  if (args.length === 0) {
    throw new InterpreterRuntimeError(
      "new URL(...) requires a URL string and an optional base URL.",
      node,
    ).as("TypeError");
  }
  const input = urlArgument(args[0], "new URL input");
  const base = args[1] === undefined ? undefined : urlArgument(args[1], "new URL base");
  assertBoundedUrlConstructionInputs(input, base, "new URL(...)", node);
  try {
    return new SandboxURL(new URL(input, base));
  } catch {
    throw new InterpreterRuntimeError(
      `new URL(...) received an invalid URL${base === undefined ? "" : " or base URL"}.`,
      node,
    ).as("TypeError");
  }
}
export function constructURLSearchParams<R, InitInput>(
  this: ConstructorsHost<R>,
  init: InitInput,
  node: AstNode,
): SandboxURLSearchParams {
  if (init === undefined) return new SandboxURLSearchParams(new URLSearchParams());
  if (init instanceof SandboxURLSearchParams) {
    // Confinement preflight: charge the copy before the native copy-constructor runs.
    assertBoundedCollectionSize(init.params.size, "new URLSearchParams(...)", node);
    return new SandboxURLSearchParams(new URLSearchParams(init.params));
  }
  if (Predicate.isString(init)) {
    // Confinement preflight: the projected pair count is charged before the native parser
    // materializes the entries.
    assertBoundedQueryPairs(init, "new URLSearchParams(...)", node);
    return new SandboxURLSearchParams(new URLSearchParams(init));
  }
  if (init === null || Predicate.isNumber(init) || Predicate.isBoolean(init)) {
    return new SandboxURLSearchParams(new URLSearchParams(coerceToString(init)));
  }
  if (init instanceof SandboxMap) {
    return this.constructURLSearchParams(
      Array.from(init.map.entries(), ([key, value]) => [key, value]),
      node,
    );
  }
  if (Array.isArray(init)) {
    const entries = init.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new InterpreterRuntimeError(
          "new URLSearchParams(...) expects an array of [name, value] pairs.",
          node,
        ).as("TypeError");
      }
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      return [
        uriArgument(pair[0], "URLSearchParams name"),
        uriArgument(pair[1], "URLSearchParams value"),
      ] as [string, string];
    });
    return new SandboxURLSearchParams(new URLSearchParams(entries));
  }
  if (isSandboxValue(init)) return new SandboxURLSearchParams(new URLSearchParams());
  const data = boundedData(init, "new URLSearchParams input");
  if (data === null || !hasObjectRuntimeType(data)) {
    throw new InterpreterRuntimeError(
      "new URLSearchParams(...) expects a query string, data object, array of pairs, or URLSearchParams.",
      node,
    ).as("TypeError");
  }
  return new SandboxURLSearchParams(
    new URLSearchParams(
      Object.fromEntries(Object.entries(data).map(([key, value]) => [key, coerceToString(value)])),
    ),
  );
}
function constructCollection<R>(
  host: IteratorHost<R>,
  source: InterpreterValue,
  node: AstNode,
  map: boolean,
): Effect.Effect<SandboxMap | SandboxSet, RuntimeFailure, R> {
  return Effect.gen(function* () {
    const output = map ? new SandboxMap() : new SandboxSet();
    if (source == null) return output;
    if (Predicate.isString(source) || Array.isArray(source))
      assertBoundedCollectionSize(source.length, map ? "new Map" : "new Set", node);
    const iterator = yield* acquireIterator(host, source, node);
    while (true) {
      const step = yield* iteratorStep(host, iterator, node);
      if (step.done) return output;
      yield* closeOnAbrupt(
        host,
        iterator,
        node,
        Effect.sync(() => {
          if (output instanceof SandboxMap) {
            if (!Array.isArray(step.value))
              throw new InterpreterRuntimeError(
                "Map iterator must yield [key, value] pairs.",
                node,
              ).as("TypeError");
            output.map.set(step.value[0], step.value[1]);
          } else output.set.add(step.value);
        }),
      );
    }
  });
}
