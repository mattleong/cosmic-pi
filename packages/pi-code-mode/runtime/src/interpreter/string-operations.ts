import * as Predicate from "effect/Predicate";
import { matchToValue, toHostRegex } from "../stdlib/regexp.js";
import { boundedData } from "../stdlib/value.js";
import { SandboxRegExp } from "../values.js";
import {
  assertBoundedCollectionSize,
  assertBoundedStringLength,
  assertConfinedRegExpOperation,
  MAX_GUEST_COLLECTION_ENTRIES,
} from "./confinement.js";
import { type AstNode, type InterpreterArray, InterpreterRuntimeError } from "./model.js";

export const invokeStringMethod = (
  value: string,
  name: string,
  args: InterpreterArray,
  node: AstNode,
) => {
  const str = (index: number): string => {
    const arg = args[index];
    if (!Predicate.isString(arg))
      throw new InterpreterRuntimeError(
        `String.${name} expects argument ${index + 1} to be a string.`,
        node,
      );
    return arg;
  };
  const num = (index: number): number => {
    const arg = args[index];
    if (!Predicate.isNumber(arg))
      throw new InterpreterRuntimeError(
        `String.${name} expects argument ${index + 1} to be a number.`,
        node,
      );
    return arg;
  };
  const optNum = (index: number): number | undefined =>
    args[index] === undefined ? undefined : num(index);
  const optStr = (index: number): string | undefined =>
    args[index] === undefined ? undefined : str(index);

  let result: StringMethodResult;
  switch (name) {
    case "toLowerCase":
      result = value.toLowerCase();
      break;
    case "toUpperCase":
      result = value.toUpperCase();
      break;
    case "trim":
      result = value.trim();
      break;
    // trimLeft/trimRight are the legacy aliases of trimStart/trimEnd, kept because models write them.
    case "trimStart":
    case "trimLeft":
      result = value.trimStart();
      break;
    case "trimEnd":
    case "trimRight":
      result = value.trimEnd();
      break;
    // Locale/options arguments are ignored: comparison runs with the host default locale, and
    // the common use is a sort comparator where any consistent order works.
    case "localeCompare":
      result = value.localeCompare(str(0));
      break;
    case "normalize": {
      const form = optStr(0);
      try {
        result = value.normalize(form);
      } catch {
        throw new InterpreterRuntimeError(
          `String.normalize expects the form "NFC", "NFD", "NFKC", or "NFKD" (got ${JSON.stringify(form)}).`,
          node,
        ).as("RangeError");
      }
      break;
    }
    case "split": {
      if (args[0] === undefined) {
        const limit = optNum(1);
        result = limit !== undefined && limit >>> 0 === 0 ? [] : [value];
        break;
      }
      if (args[0] instanceof SandboxRegExp) {
        // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
        const pattern = (args[0] as SandboxRegExp).regex;
        assertConfinedRegExpOperation(pattern, value, "String.split", node);
        // Bounded post-check (not a preflight): the entry count - pieces plus captured
        // separators - is unknowable without matching, so the native limit clamps the
        // materialization to the entry cap + 1 and the first over-cap result is refused
        // after the (already bounded) native call.
        const regexLimit = optNum(1);
        const clampedLimit = Math.min(
          regexLimit === undefined ? Infinity : regexLimit >>> 0,
          MAX_GUEST_COLLECTION_ENTRIES + 1,
        );
        const parts = value.split(pattern, clampedLimit);
        assertBoundedCollectionSize(parts.length, "String.split", node);
        result = parts;
        break;
      }
      const requestedLimit = optNum(1);
      const limit = requestedLimit === undefined ? undefined : requestedLimit >>> 0;
      const separator = str(0);
      // Confinement preflight: the piece count is projected (indexOf scan, no allocation,
      // early bail) and refused before the native split materializes the array.
      let pieces: number;
      if (separator.length === 0) {
        pieces = value.length;
      } else {
        pieces = 1;
        for (
          let found = value.indexOf(separator);
          found !== -1 && pieces <= MAX_GUEST_COLLECTION_ENTRIES;
          found = value.indexOf(separator, found + separator.length)
        ) {
          pieces += 1;
        }
      }
      assertBoundedCollectionSize(Math.min(pieces, limit ?? Infinity), "String.split", node);
      result = value.split(separator, limit);
      break;
    }
    case "slice":
      result = value.slice(optNum(0), optNum(1));
      break;
    case "includes":
      result = value.includes(str(0), optNum(1));
      break;
    case "startsWith":
      result = value.startsWith(str(0), optNum(1));
      break;
    case "endsWith":
      result = value.endsWith(str(0), optNum(1));
      break;
    case "indexOf":
      result = value.indexOf(str(0), optNum(1));
      break;
    case "lastIndexOf":
      result = value.lastIndexOf(str(0), optNum(1));
      break;
    case "replace":
    case "replaceAll": {
      // Confinement preflight: a global replacement can expand every position, so the
      // worst-case result length is charged before the native call allocates it.
      const guardExpansion = (global: boolean, replacementLength: number): void => {
        const worst = global
          ? value.length + (value.length + 1) * (replacementLength + 1)
          : value.length + replacementLength;
        assertBoundedStringLength(worst, `String.${name}`, node);
      };
      if (args[0] instanceof SandboxRegExp) {
        // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
        const pattern = (args[0] as SandboxRegExp).regex;
        const replacement = str(1);
        if (name === "replaceAll" && !pattern.global) {
          throw new InterpreterRuntimeError(
            `String.replaceAll requires a regular expression with the global (g) flag: write /${pattern.source}/${pattern.flags}g, or use String.replace to replace only the first match.`,
            node,
          );
        }
        assertConfinedRegExpOperation(pattern, value, `String.${name}`, node);
        guardExpansion(name === "replaceAll" || pattern.global, replacement.length);
        result =
          name === "replace"
            ? value.replace(pattern, replacement)
            : value.replaceAll(pattern, replacement);
        break;
      }
      if (name === "replace") {
        guardExpansion(false, str(1).length);
        result = value.replace(str(0), str(1));
        break;
      }
      guardExpansion(true, str(1).length);
      result = value.replaceAll(str(0), str(1));
      break;
    }
    case "match": {
      const pattern = toHostRegex(args[0], name, node);
      assertConfinedRegExpOperation(pattern, value, "String.match", node);
      const matched = value.match(pattern);
      if (matched === null) return null;
      // A global match is a plain array of matched strings; a non-global match carries
      // index/groups own properties, so bypass the copying data checkpoint to keep them.
      if (pattern.global) return boundedData(matched, "String.match result");
      return matchToValue(matched);
    }
    case "matchAll": {
      const pattern = toHostRegex(args[0], name, node, "g");
      if (!pattern.global) {
        throw new InterpreterRuntimeError(
          `String.matchAll requires a regular expression with the global (g) flag: write /${pattern.source}/${pattern.flags}g, or use String.match for a single match.`,
          node,
        );
      }
      assertConfinedRegExpOperation(pattern, value, "String.matchAll", node);
      // Materialized as an array (not an iterator); each entry is a match array with
      // index/groups own properties. This is a bounded post-check, not a preflight: the
      // match count is unknowable without matching but is bounded by the admitted subject
      // length + 1 (empty matches) and each match's entries by the capped pattern length,
      // so the materialization is bounded before the entry cap is applied to the result.
      const matches = Array.from(value.matchAll(pattern), matchToValue);
      assertBoundedCollectionSize(matches.length, "String.matchAll", node);
      return matches;
    }
    case "search": {
      const pattern = toHostRegex(args[0], name, node);
      assertConfinedRegExpOperation(pattern, value, "String.search", node);
      result = value.search(pattern);
      break;
    }
    case "repeat": {
      const count = num(0);
      if (!Number.isFinite(count) || count < 0)
        throw new InterpreterRuntimeError(
          "String.repeat expects a finite non-negative count.",
          node,
        );
      // Confinement preflight: the result size is exact, so refuse before allocating.
      assertBoundedStringLength(value.length * Math.floor(count), "String.repeat", node);
      result = value.repeat(count);
      break;
    }
    case "padStart":
      assertBoundedStringLength(Math.max(value.length, num(0)), "String.padStart", node);
      result = value.padStart(num(0), optStr(1));
      break;
    case "padEnd":
      assertBoundedStringLength(Math.max(value.length, num(0)), "String.padEnd", node);
      result = value.padEnd(num(0), optStr(1));
      break;
    case "charAt":
      result = value.charAt(optNum(0) ?? 0);
      break;
    case "at":
      result = value.at(optNum(0) ?? 0);
      break;
    case "substring":
      result = value.substring(optNum(0) ?? 0, optNum(1));
      break;
    case "substr":
      result = value.substr(optNum(0) ?? 0, optNum(1));
      break;
    // JS charCodeAt returns NaN out of range; NaN flows as an ordinary in-sandbox value
    // (normalized to null only at the data boundary - see copyOut), so return it as-is.
    case "charCodeAt":
      result = value.charCodeAt(optNum(0) ?? 0);
      break;
    case "codePointAt":
      result = value.codePointAt(optNum(0) ?? 0);
      break;
    case "toString":
      result = value;
      break;
    case "concat": {
      const parts = args.map((_, index) => str(index));
      assertBoundedStringLength(
        parts.reduce((total, part) => total + part.length, value.length),
        "String.concat",
        node,
      );
      result = value.concat(...parts);
      break;
    }
    default:
      throw new InterpreterRuntimeError(
        `String method '${name}' is not available in CodeMode.`,
        node,
      );
  }
  return boundedData(result, `String.${name} result`);
};
type StringMethodResult = string | number | boolean | Array<string> | undefined;
