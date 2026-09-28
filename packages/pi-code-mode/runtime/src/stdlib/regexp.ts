/** The readable RegExp properties; `lastIndex` is also writable (see members). */
import * as Predicate from "effect/Predicate";
import { runtimeTypeName } from "../runtime-values.js";
import { assertConfinedRegExp, assertConfinedRegExpOperation } from "../interpreter/regex-guard.js";
import {
  type AstNode,
  type InterpreterArray,
  type InterpreterObject,
  type InterpreterValue,
  InterpreterRuntimeError,
  makeInterpreterObject,
} from "../interpreter/model.js";
import { SandboxRegExp } from "../values.js";
import { MethodTable } from "./method-table.js";
import { coerceToString } from "../interpreter/conversions.js";

export const regexpProperties = new MethodTable<(value: SandboxRegExp) => InterpreterValue>({
  source: (value) => value.regex.source,
  flags: (value) => value.regex.flags,
  lastIndex: (value) => value.regex.lastIndex,
  global: (value) => value.regex.global,
  ignoreCase: (value) => value.regex.ignoreCase,
  multiline: (value) => value.regex.multiline,
  sticky: (value) => value.regex.sticky,
  unicode: (value) => value.regex.unicode,
  dotAll: (value) => value.regex.dotAll,
});

export const regexpProperty = (value: SandboxRegExp, name: string): InterpreterValue =>
  regexpProperties.get(name)?.(value);

export const regexFailureReason = <ErrorInput>(error: ErrorInput): string =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Invalid regular expression:\s*/i,
    "",
  );

export const escapeRegexHint =
  'To match special characters like ( ) [ ] { } + * ? . literally, escape them with a backslash (e.g. "\\\\(") or test for them with String.includes instead.';

export const toHostRegex = (
  arg: InterpreterValue,
  method: string,
  node: AstNode,
  extraFlags = "",
): RegExp => {
  if (arg instanceof SandboxRegExp) return arg.regex;
  if (Predicate.isString(arg)) {
    let regex: RegExp;
    try {
      regex = new RegExp(arg, extraFlags);
    } catch (error) {
      throw new InterpreterRuntimeError(
        `String.${method} received the string ${JSON.stringify(arg)}, which is not a valid regular expression pattern (${regexFailureReason(error)}). ${escapeRegexHint}`,
        node,
      ).as("SyntaxError");
    }
    assertConfinedRegExp(regex, node);
    return regex;
  }
  throw new InterpreterRuntimeError(
    `String.${method} expects a regular expression (a /pattern/flags literal or new RegExp(...)) or a string pattern, not ${arg === null ? "null" : runtimeTypeName(arg)}.`,
    node,
  );
};

interface RegExpMatchValue extends Array<InterpreterValue> {
  index?: number;
  input?: string;
  groups?: InterpreterObject;
}

export const matchToValue = (match: RegExpMatchArray): RegExpMatchValue => {
  const result: RegExpMatchValue = Array.from(match, (group) => group);
  if (match.index !== undefined) result.index = match.index;
  if (match.input !== undefined) result.input = match.input;
  if (match.groups) {
    const groups = makeInterpreterObject();
    for (const [key, group] of Object.entries(match.groups)) {
      groups[key] = group;
    }
    result.groups = groups;
  }
  return result;
};

type RegExpMethod = (
  value: SandboxRegExp,
  args: InterpreterArray,
  node: AstNode,
) => InterpreterValue;

export const regexpMethods = new MethodTable<RegExpMethod>({
  test: (value, args, node) => {
    const subject = coerceToString(args[0]);
    assertConfinedRegExpOperation(value.regex, subject, "RegExp.test", node);
    return value.regex.test(subject);
  },
  exec: (value, args, node) => {
    const subject = coerceToString(args[0]);
    assertConfinedRegExpOperation(value.regex, subject, "RegExp.exec", node);
    const matched = value.regex.exec(subject);
    return matched === null ? null : matchToValue(matched);
  },
  // `toString` is typed explicitly: object literals type that key from Object.prototype.
  toString: (value: SandboxRegExp) => coerceToString(value),
});

export const invokeRegExpMethod = (
  value: SandboxRegExp,
  name: string,
  args: InterpreterArray,
  node: AstNode,
) => {
  const method = regexpMethods.get(name);
  if (method === undefined)
    throw new InterpreterRuntimeError(
      `RegExp method '${name}' is not available in CodeMode.`,
      node,
    );
  return method(value, args, node);
};
