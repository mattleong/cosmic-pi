import {
  acquireIterator,
  iteratorStep,
  closeOnAbrupt,
  hasSyncIterator,
  materializeIterable,
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
import { boundedData, errorConstructors } from "../stdlib/value.js";
import { coerceToNumber, coerceToString } from "./conversions.js";
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
  createErrorValue,
  attachErrorCause,
} from "../values.js";
import {
  assertBoundedCollectionSize,
  assertBoundedQueryPairs,
  assertBoundedUrlConstructionInputs,
} from "./confinement.js";
import { assertConfinedRegExp } from "./regex-guard.js";
import {
  type AstNode,
  getArray,
  getNode,
  type InterpreterArray,
  InterpreterRuntimeError,
  type InterpreterValue,
  supportedSyntaxMessage,
  GlobalNamespace,
  ErrorConstructorReference,
  PromiseNamespace,
  CoercionFunction,
} from "./model.js";
import { calleeText } from "./diagnostics.js";
import { evaluateCallArguments } from "./callable.js";
import { evaluateExpression } from "./expressions.js";
import { constructAggregateError } from "./promises.js";
import { type Activation } from "./activation.js";

export function evaluateNewExpression<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  const calleeNode = getNode(node, "callee");
  const argNodes = getArray(node, "arguments");
  return Effect.gen(function* () {
    // The constructor is the callee's value, not its spelling, so aliases (`const E = Error`)
    // construct and shadowing bindings (`const Map = ...`) do not.
    const callee = yield* evaluateExpression(act, calleeNode);
    const name = constructorName(callee);
    if (name === "Promise") {
      throw new InterpreterRuntimeError(
        "new Promise(...) is not supported in CodeMode; tool calls already return promises - call the tool and await the result.",
        node,
        "UnsupportedSyntax",
        [supportedSyntaxMessage],
      );
    }
    if (name === undefined)
      throw new InterpreterRuntimeError(
        callee instanceof CoercionFunction
          ? `new ${callee.name}(...) is not supported in CodeMode; call ${callee.name}(...) without new.`
          : `${calleeText(calleeNode)} is not a constructor. CodeMode constructs Date, RegExp, Map, Set, URL, URLSearchParams, Uint8Array, TextEncoder, TextDecoder, and Error types.`,
        calleeNode,
      ).as("TypeError");
    const args = yield* evaluateCallArguments(act, argNodes);
    if (name === "TextEncoder") {
      if (args.length !== 0)
        throw new InterpreterRuntimeError("TextEncoder takes no options.", node).as("TypeError");
      return new SandboxTextEncoder();
    }
    if (name === "TextDecoder") return constructTextDecoder(args, node);
    if (name === "Uint8Array") {
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
          ? yield* materializeIterable(act, source, node, "Uint8Array constructor")
          : source,
        node,
      );
    }
    if (errorConstructors.has(name)) {
      if (name === "AggregateError") {
        args[0] = yield* materializeIterable(act, args[0], node, "AggregateError errors");
        return constructAggregateError(args, node);
      }
      const error = createErrorValue(name, args[0] === undefined ? "" : coerceToString(args[0]));
      attachErrorCause(error, args[1]);
      return error;
    }
    switch (name) {
      case "Date":
        return constructDate(args);
      case "RegExp":
        return constructRegExp(args, node);
      case "Map":
        return yield* constructCollection(act, args[0], node, true);
      case "Set":
        return yield* constructCollection(act, args[0], node, false);
      case "URL":
        return constructURL(args, node);
      default:
        return constructURLSearchParams(
          args[0] != null && !Predicate.isString(args[0]) && hasSyncIterator(args[0])
            ? yield* materializeIterable(act, args[0], node, "URLSearchParams")
            : args[0],
          node,
        );
    }
  });
}

/** The global namespaces `new` constructs; everything else is refused before arguments run. */
const constructibleNamespaces = new Set([
  "Date",
  "RegExp",
  "Map",
  "Set",
  "URL",
  "URLSearchParams",
  "Uint8Array",
  "TextEncoder",
  "TextDecoder",
]);

/** The built-in a `new` callee value constructs, or undefined when it is not a constructor. */
const constructorName = (callee: InterpreterValue): string | undefined => {
  if (callee instanceof GlobalNamespace && constructibleNamespaces.has(callee.name))
    return callee.name;
  if (callee instanceof ErrorConstructorReference) return callee.name;
  if (callee instanceof PromiseNamespace) return "Promise";
  return undefined;
};
export function constructDate(args: InterpreterArray): SandboxDate {
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
export function constructRegExp(args: InterpreterArray, node: AstNode): SandboxRegExp {
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
export function constructURL(args: InterpreterArray, node: AstNode): SandboxURL {
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
export function constructURLSearchParams<InitInput>(
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
    return constructURLSearchParams(
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
  host: Activation<R>,
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
