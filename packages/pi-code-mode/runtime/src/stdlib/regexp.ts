export const regexpMethods = new Set(["test", "exec", "toString"]);

export const regexpProperties = new Set([
  "source",
  "flags",
  "lastIndex",
  "global",
  "ignoreCase",
  "multiline",
  "sticky",
  "unicode",
  "dotAll",
]);

export const regexpProperty = (value: SandboxRegExp, name: string): InterpreterValue => {
  switch (name) {
    case "source":
      return value.regex.source;
    case "flags":
      return value.regex.flags;
    case "lastIndex":
      return value.regex.lastIndex;
    case "global":
      return value.regex.global;
    case "ignoreCase":
      return value.regex.ignoreCase;
    case "multiline":
      return value.regex.multiline;
    case "sticky":
      return value.regex.sticky;
    case "unicode":
      return value.regex.unicode;
    case "dotAll":
      return value.regex.dotAll;
    default:
      return undefined;
  }
};

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
  groups?: InterpreterObject;
}

export const matchToValue = (match: RegExpMatchArray): RegExpMatchValue => {
  const result: RegExpMatchValue = Array.from(match, (group) => group);
  if (match.index !== undefined) result.index = match.index;
  if (match.groups) {
    const groups = makeInterpreterObject();
    for (const [key, group] of Object.entries(match.groups)) {
      if (!isBlockedMember(key)) groups[key] = group;
    }
    result.groups = groups;
  }
  return result;
};

export const invokeRegExpMethod = (
  value: SandboxRegExp,
  name: string,
  args: InterpreterArray,
  node: AstNode,
) => {
  switch (name) {
    case "test": {
      const subject = coerceToString(args[0]);
      assertConfinedRegExpOperation(value.regex, subject, "RegExp.test", node);
      return value.regex.test(subject);
    }
    case "exec": {
      const subject = coerceToString(args[0]);
      assertConfinedRegExpOperation(value.regex, subject, "RegExp.exec", node);
      const matched = value.regex.exec(subject);
      return matched === null ? null : matchToValue(matched);
    }
    case "toString":
      return coerceToString(value);
    default:
      throw new InterpreterRuntimeError(
        `RegExp method '${name}' is not available in CodeMode.`,
        node,
      );
  }
};
import * as Predicate from "effect/Predicate";
import { runtimeTypeName } from "../runtime-values.ts";
import { assertConfinedRegExp, assertConfinedRegExpOperation } from "../interpreter/confinement.js";
import {
  type AstNode,
  type InterpreterArray,
  type InterpreterObject,
  type InterpreterValue,
  InterpreterRuntimeError,
  makeInterpreterObject,
} from "../interpreter/model.js";
import { isBlockedMember } from "../tool-runtime.js";
import { SandboxRegExp } from "../values.js";
import { coerceToString } from "./value.js";
