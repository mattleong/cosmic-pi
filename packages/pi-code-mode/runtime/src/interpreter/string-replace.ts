import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType } from "../runtime-values.js";
import { SandboxRegExp } from "../values.js";
import { assertBoundedCollectionSize, assertBoundedStringLength } from "./confinement.js";
import { assertConfinedRegExpOperation } from "./regex-guard.js";
import {
  type AstNode,
  type InterpreterArray,
  type InterpreterObject,
  InterpreterRuntimeError,
  type InterpreterValue,
  makeInterpreterObject,
} from "./model.js";

type ReplaceName = "replace" | "replaceAll";

/** One native replace match, projected for a guest replacer callback. */
export interface ReplaceMatch {
  readonly match: string;
  readonly offset: number;
  readonly args: InterpreterArray;
}

interface NativeMatch {
  readonly match: string;
  readonly offset: number;
  readonly captures: ReadonlyArray<string | undefined>;
  readonly groups: Readonly<Record<string, string | undefined>> | undefined;
}

/**
 * Assembles a replacement result, charging each part before `join` allocates it. Replacement
 * text can repeat the whole subject per match (`$\``, `$'`, captures), so no size is projected
 * up front; every appended part is counted against the string cap instead.
 */
export class ReplacementOutput {
  private readonly parts: Array<string> = [];
  private total = 0;
  private readonly label: string;
  private readonly node: AstNode;

  constructor(label: string, node: AstNode) {
    this.label = label;
    this.node = node;
  }

  push(part: string): void {
    this.total += part.length;
    assertBoundedStringLength(this.total, this.label, this.node);
    this.parts.push(part);
  }

  finish(): string {
    return this.parts.join("");
  }
}

/**
 * Runs the native matcher for `replace`/`replaceAll` and reports each match in order. The
 * native call only ever rebuilds the subject, because the visitor returns the match itself.
 */
const visitMatches = (
  value: string,
  name: ReplaceName,
  pattern: InterpreterValue,
  node: AstNode,
  visit: (match: NativeMatch, args: InterpreterArray) => void,
): void => {
  let count = 0;
  const collect = (...callbackArgs: InterpreterArray): string => {
    const match = callbackArgs[0];
    const last = callbackArgs[callbackArgs.length - 1];
    const hasGroups = last !== null && hasObjectRuntimeType(last);
    const offsetIndex = callbackArgs.length - (hasGroups ? 3 : 2);
    const offset = callbackArgs[offsetIndex];
    if (!Predicate.isString(match) || !Predicate.isNumber(offset)) {
      throw new InterpreterRuntimeError(
        `String.${name} produced an invalid replacement match.`,
        node,
      );
    }
    count += 1;
    assertBoundedCollectionSize(count, `String.${name} matches`, node);
    // SAFETY: Native replace passes capture groups as strings or undefined.
    const captures = callbackArgs.slice(1, offsetIndex) as ReadonlyArray<string | undefined>;
    // SAFETY: Native replace passes named groups as a record of strings or undefined.
    const groups = hasGroups ? (last as Readonly<Record<string, string | undefined>>) : undefined;
    visit({ match, offset, captures, groups }, callbackArgs);
    return match;
  };
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
    return;
  }
  if (!Predicate.isString(pattern)) {
    throw new InterpreterRuntimeError(`String.${name} expects argument 1 to be a string.`, node);
  }
  if (name === "replace") value.replace(pattern, collect);
  else value.replaceAll(pattern, collect);
};

/** Collects every match before guest replacer callbacks run, since callbacks are effects. */
export const collectReplaceMatches = (
  value: string,
  name: ReplaceName,
  pattern: InterpreterValue,
  node: AstNode,
): ReadonlyArray<ReplaceMatch> => {
  const matches: Array<ReplaceMatch> = [];
  visitMatches(value, name, pattern, node, (native, args) => {
    if (native.groups !== undefined) {
      const safeGroups: InterpreterObject = makeInterpreterObject();
      for (const [key, group] of Object.entries(native.groups)) {
        safeGroups[key] = group;
      }
      args[args.length - 1] = safeGroups;
    }
    matches.push({ match: native.match, offset: native.offset, args });
  });
  return matches;
};

/**
 * `String.prototype.replace` with a replacement string. The interpreter expands `$` patterns
 * itself (ECMAScript GetSubstitution) so the result is charged part by part as it grows.
 */
export const replaceWithTemplate = (
  value: string,
  name: ReplaceName,
  pattern: InterpreterValue,
  template: string,
  node: AstNode,
): string => {
  const output = new ReplacementOutput(`String.${name} result`, node);
  let end = 0;
  visitMatches(value, name, pattern, node, (match) => {
    output.push(value.slice(end, match.offset));
    expandTemplate(template, value, match, output);
    end = match.offset + match.match.length;
  });
  output.push(value.slice(end));
  return output.finish();
};

const isDigit = (code: number): boolean => code >= 48 && code <= 57;

const expandTemplate = (
  template: string,
  subject: string,
  { match, offset, captures, groups }: NativeMatch,
  output: ReplacementOutput,
): void => {
  let index = 0;
  while (index < template.length) {
    const dollar = template.indexOf("$", index);
    if (dollar === -1 || dollar === template.length - 1) {
      output.push(template.slice(index));
      return;
    }
    output.push(template.slice(index, dollar));
    const next = template[dollar + 1];
    const nextCode = template.charCodeAt(dollar + 1);
    if (next === "$") {
      output.push("$");
      index = dollar + 2;
    } else if (next === "&") {
      output.push(match);
      index = dollar + 2;
    } else if (next === "`") {
      output.push(subject.slice(0, offset));
      index = dollar + 2;
    } else if (next === "'") {
      output.push(subject.slice(Math.min(offset + match.length, subject.length)));
      index = dollar + 2;
    } else if (isDigit(nextCode)) {
      let digits = isDigit(template.charCodeAt(dollar + 2)) ? 2 : 1;
      let group = Number(template.slice(dollar + 1, dollar + 1 + digits));
      if (group > captures.length && digits === 2) {
        digits = 1;
        group = Number(template[dollar + 1]);
      }
      const reference = template.slice(dollar, dollar + 1 + digits);
      output.push(group >= 1 && group <= captures.length ? (captures[group - 1] ?? "") : reference);
      index = dollar + 1 + digits;
    } else if (next === "<") {
      const close = template.indexOf(">", dollar + 2);
      if (groups === undefined || close === -1) {
        output.push("$<");
        index = dollar + 2;
      } else {
        const groupName = template.slice(dollar + 2, close);
        output.push(Object.hasOwn(groups, groupName) ? (groups[groupName] ?? "") : "");
        index = close + 1;
      }
    } else {
      output.push("$");
      index = dollar + 1;
    }
  }
};
