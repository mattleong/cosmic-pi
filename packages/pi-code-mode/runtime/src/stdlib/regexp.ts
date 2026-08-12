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

export const regexFailureReason = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Invalid regular expression:\s*/i,
    "",
  );

export const escapeRegexHint =
  'To match special characters like ( ) [ ] { } + * ? . literally, escape them with a backslash (e.g. "\\\\(") or test for them with String.includes instead.';

export const toHostRegex = (
  arg: unknown,
  method: string,
  node: AstNode,
  extraFlags = "",
): RegExp => {
  if (arg instanceof SandboxRegExp) return arg.regex;
  if (typeof arg === "string") {
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
    `String.${method} expects a regular expression (a /pattern/flags literal or new RegExp(...)) or a string pattern, not ${arg === null ? "null" : typeof arg}.`,
    node,
  );
};

export const matchToValue = (match: RegExpMatchArray): Array<unknown> => {
  const result: Array<unknown> = Array.from(match, (group) => group);
  if (match.index !== undefined)
    (result as Record<string, unknown> & Array<unknown>).index = match.index;
  if (match.groups) {
    const groups: SafeObject = Object.create(null) as SafeObject;
    for (const [key, group] of Object.entries(match.groups)) {
      if (!isBlockedMember(key)) groups[key] = group;
    }
    (result as Record<string, unknown> & Array<unknown>).groups = groups;
  }
  return result;
};

export const invokeRegExpMethod = (
  value: SandboxRegExp,
  name: string,
  args: Array<unknown>,
  node: AstNode,
): unknown => {
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
import { assertConfinedRegExp, assertConfinedRegExpOperation } from "../interpreter/confinement.js";
import { type AstNode, InterpreterRuntimeError } from "../interpreter/model.js";
import { isBlockedMember, type SafeObject } from "../tool-runtime.js";
import { SandboxRegExp } from "../values.js";
import { coerceToString } from "./value.js";
