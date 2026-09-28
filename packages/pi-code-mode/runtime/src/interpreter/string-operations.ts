import * as Predicate from "effect/Predicate";
import { matchToValue, toHostRegex } from "../stdlib/regexp.js";
import { boundedData } from "../stdlib/value.js";
import { SandboxRegExp } from "../values.js";
import {
  assertBoundedCollectionSize,
  assertBoundedStringLength,
  MAX_GUEST_COLLECTION_ENTRIES,
  MAX_GUEST_STRING_LENGTH,
} from "./confinement.js";
import { assertConfinedRegExpOperation } from "./regex-guard.js";
import {
  type AstNode,
  type InterpreterArray,
  InterpreterRuntimeError,
  type InterpreterValue,
} from "./model.js";
import { replaceWithTemplate } from "./string-replace.js";
import { MethodTable } from "../stdlib/method-table.js";
import { hasObjectRuntimeType } from "../runtime-values.js";

const collatorOptionValues = {
  sensitivity: ["base", "accent", "case", "variant"],
  caseFirst: ["upper", "lower", "false"],
  usage: ["sort", "search"],
} as const;

const collators = new Map<string, Intl.Collator>();

/**
 * The collator behind `localeCompare(that, locales, options)`. Locales are strings; options
 * are limited to the documented Intl.Collator fields. Collators are cached per argument set,
 * since building one per comparison would make locale-aware sorts slow.
 */
const collatorFor = (
  locales: InterpreterValue,
  options: InterpreterValue,
  node: AstNode,
): Intl.Collator => {
  const invalid = (detail: string) =>
    new InterpreterRuntimeError(`String.localeCompare ${detail}.`, node).as("RangeError");
  let locale: string | Array<string> | undefined;
  if (Predicate.isString(locales)) locale = locales;
  else if (Array.isArray(locales)) {
    locale = locales.filter(Predicate.isString);
    if (locale.length !== locales.length) throw invalid("expects locales to be strings");
  } else if (locales !== undefined) throw invalid("expects locales to be a string or strings");
  const settings: Intl.CollatorOptions = {};
  if (options !== undefined) {
    if (options === null || !hasObjectRuntimeType(options) || Array.isArray(options))
      throw invalid("expects options to be an object");
    // SAFETY: A non-null, non-array guest object is a record of own data members.
    const record = options as Readonly<Record<string, InterpreterValue>>;
    for (const key of ["numeric", "ignorePunctuation"] as const) {
      const flag = record[key];
      if (flag !== undefined) settings[key] = Boolean(flag);
    }
    for (const key of ["sensitivity", "caseFirst", "usage"] as const) {
      const choice = record[key];
      if (choice === undefined) continue;
      if (!collatorOptionValues[key].some((allowed) => allowed === choice))
        throw invalid(
          `expects options.${key} to be one of ${collatorOptionValues[key].join(", ")}`,
        );
      Object.assign(settings, { [key]: choice });
    }
  }
  const cacheKey = JSON.stringify([locale ?? null, settings]);
  let collator = collators.get(cacheKey);
  if (collator === undefined) {
    try {
      collator = new Intl.Collator(locale, settings);
    } catch {
      throw invalid(`received an unsupported locale ${JSON.stringify(locale)}`);
    }
    if (collators.size >= 32) collators.clear();
    collators.set(cacheKey, collator);
  }
  return collator;
};

/** Worst-case UTF-16 growth of Unicode case mapping (e.g. U+0390 uppercases to 3 units). */
const CASE_MAPPING_GROWTH = 3;

/** Worst-case UTF-16 growth of each normalization form (U+FDFA expands to 18 under NFK*). */
const NORMALIZATION_GROWTH = { NFC: 3, NFD: 4, NFKC: 18, NFKD: 18 } as const;

const normalizationGrowth = (form: string | undefined): number => {
  switch (form ?? "NFC") {
    case "NFC":
      return NORMALIZATION_GROWTH.NFC;
    case "NFD":
      return NORMALIZATION_GROWTH.NFD;
    case "NFKC":
      return NORMALIZATION_GROWTH.NFKC;
    case "NFKD":
      return NORMALIZATION_GROWTH.NFKD;
    default:
      // Invalid forms are refused by the native call before it allocates.
      return 1;
  }
};

const isAscii = (value: string): boolean => {
  for (let index = 0; index < value.length; index++)
    if (value.charCodeAt(index) > 0x7f) return false;
  return true;
};

/**
 * Preflight for operations that can lengthen non-ASCII text by a bounded factor. ASCII text
 * never grows under case mapping or normalization, so only non-ASCII input pays the factor.
 */
const assertBoundedGrowth = (value: string, factor: number, label: string, node: AstNode) => {
  if (value.length * factor > MAX_GUEST_STRING_LENGTH && !isAscii(value))
    assertBoundedStringLength(value.length * factor, label, node);
};

/** One string method's arguments, checked as they are read; messages name the method. */
interface StringArgs {
  readonly name: string;
  readonly args: InterpreterArray;
  readonly node: AstNode;
  str(index: number): string;
  num(index: number): number;
  optNum(index: number): number | undefined;
  optStr(index: number): string | undefined;
}

const stringArgs = (name: string, args: InterpreterArray, node: AstNode): StringArgs => {
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
  return {
    name,
    args,
    node,
    str,
    num,
    optNum: (index) => (args[index] === undefined ? undefined : num(index)),
    optStr: (index) => (args[index] === undefined ? undefined : str(index)),
  };
};

/** A result already bounded by its method, kept as is to preserve match metadata. */
class CheckedResult {
  readonly value: InterpreterValue;
  constructor(value: InterpreterValue) {
    this.value = value;
  }
}

type StringMethod = (value: string, a: StringArgs) => InterpreterValue | CheckedResult;

const splitString: StringMethod = (value, a) => {
  if (a.args[0] === undefined) {
    const limit = a.optNum(1);
    return limit !== undefined && limit >>> 0 === 0 ? [] : [value];
  }
  const separatorArg = a.args[0];
  if (separatorArg instanceof SandboxRegExp) {
    const pattern = separatorArg.regex;
    assertConfinedRegExpOperation(pattern, value, "String.split", a.node);
    // Bounded post-check (not a preflight): the entry count - pieces plus captured
    // separators - is unknowable without matching, so the native limit clamps the
    // materialization to the entry cap + 1 and the first over-cap result is refused
    // after the (already bounded) native call.
    const regexLimit = a.optNum(1);
    const clampedLimit = Math.min(
      regexLimit === undefined ? Infinity : regexLimit >>> 0,
      MAX_GUEST_COLLECTION_ENTRIES + 1,
    );
    const parts = value.split(pattern, clampedLimit);
    assertBoundedCollectionSize(parts.length, "String.split", a.node);
    return parts;
  }
  const requestedLimit = a.optNum(1);
  const limit = requestedLimit === undefined ? undefined : requestedLimit >>> 0;
  const separator = a.str(0);
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
  assertBoundedCollectionSize(Math.min(pieces, limit ?? Infinity), "String.split", a.node);
  return value.split(separator, limit);
};

const replaceString: StringMethod = (value, a) =>
  replaceWithTemplate(
    value,
    a.name === "replaceAll" ? "replaceAll" : "replace",
    a.args[0],
    a.str(1),
    a.node,
  );

export const stringMethods = new MethodTable<StringMethod>({
  toLowerCase: (value, a) => {
    assertBoundedGrowth(value, CASE_MAPPING_GROWTH, "String.toLowerCase", a.node);
    return value.toLowerCase();
  },
  toUpperCase: (value, a) => {
    assertBoundedGrowth(value, CASE_MAPPING_GROWTH, "String.toUpperCase", a.node);
    return value.toUpperCase();
  },
  trim: (value) => value.trim(),
  // trimLeft/trimRight are the legacy aliases of trimStart/trimEnd, kept because models write them.
  trimStart: (value) => value.trimStart(),
  trimLeft: (value) => value.trimStart(),
  trimEnd: (value) => value.trimEnd(),
  trimRight: (value) => value.trimEnd(),
  localeCompare: (value, a) => collatorFor(a.args[1], a.args[2], a.node).compare(value, a.str(0)),
  normalize: (value, a) => {
    const form = a.optStr(0);
    assertBoundedGrowth(value, normalizationGrowth(form), "String.normalize", a.node);
    try {
      return value.normalize(form);
    } catch {
      throw new InterpreterRuntimeError(
        `String.normalize expects the form "NFC", "NFD", "NFKC", or "NFKD" (got ${JSON.stringify(form)}).`,
        a.node,
      ).as("RangeError");
    }
  },
  split: splitString,
  slice: (value, a) => value.slice(a.optNum(0), a.optNum(1)),
  includes: (value, a) => value.includes(a.str(0), a.optNum(1)),
  startsWith: (value, a) => value.startsWith(a.str(0), a.optNum(1)),
  endsWith: (value, a) => value.endsWith(a.str(0), a.optNum(1)),
  indexOf: (value, a) => value.indexOf(a.str(0), a.optNum(1)),
  lastIndexOf: (value, a) => value.lastIndexOf(a.str(0), a.optNum(1)),
  replace: replaceString,
  replaceAll: replaceString,
  match: (value, a) => {
    const pattern = toHostRegex(a.args[0], a.name, a.node);
    assertConfinedRegExpOperation(pattern, value, "String.match", a.node);
    const matched = value.match(pattern);
    if (matched === null) return null;
    // A global match is a plain array of matched strings; a non-global match carries
    // index/groups own properties, so bypass the copying data checkpoint to keep them.
    if (pattern.global) return matched;
    return new CheckedResult(matchToValue(matched));
  },
  matchAll: (value, a) => {
    const pattern = toHostRegex(a.args[0], a.name, a.node, "g");
    if (!pattern.global) {
      throw new InterpreterRuntimeError(
        `String.matchAll requires a regular expression with the global (g) flag: write /${pattern.source}/${pattern.flags}g, or use String.match for a single match.`,
        a.node,
      );
    }
    assertConfinedRegExpOperation(pattern, value, "String.matchAll", a.node);
    // Materialized as an array (not an iterator); each entry is a match array with
    // index/groups own properties. The count is charged per match, so an over-cap result
    // is refused at the first extra match rather than after materializing all of them.
    const matches: Array<InterpreterValue> = [];
    for (const match of value.matchAll(pattern)) {
      assertBoundedCollectionSize(matches.length + 1, "String.matchAll", a.node);
      matches.push(matchToValue(match));
    }
    return new CheckedResult(matches);
  },
  search: (value, a) => {
    const pattern = toHostRegex(a.args[0], a.name, a.node);
    assertConfinedRegExpOperation(pattern, value, "String.search", a.node);
    return value.search(pattern);
  },
  repeat: (value, a) => {
    const count = a.num(0);
    if (!Number.isFinite(count) || count < 0)
      throw new InterpreterRuntimeError(
        "String.repeat expects a finite non-negative count.",
        a.node,
      );
    // Confinement preflight: the result size is exact, so refuse before allocating.
    assertBoundedStringLength(value.length * Math.floor(count), "String.repeat", a.node);
    return value.repeat(count);
  },
  padStart: (value, a) => {
    assertBoundedStringLength(Math.max(value.length, a.num(0)), "String.padStart", a.node);
    return value.padStart(a.num(0), a.optStr(1));
  },
  padEnd: (value, a) => {
    assertBoundedStringLength(Math.max(value.length, a.num(0)), "String.padEnd", a.node);
    return value.padEnd(a.num(0), a.optStr(1));
  },
  charAt: (value, a) => value.charAt(a.optNum(0) ?? 0),
  at: (value, a) => value.at(a.optNum(0) ?? 0),
  substring: (value, a) => value.substring(a.optNum(0) ?? 0, a.optNum(1)),
  substr: (value, a) => value.substr(a.optNum(0) ?? 0, a.optNum(1)),
  // JS charCodeAt returns NaN out of range; NaN flows as an ordinary in-sandbox value
  // (normalized to null only at the data boundary - see copyOut), so return it as-is.
  charCodeAt: (value, a) => value.charCodeAt(a.optNum(0) ?? 0),
  codePointAt: (value, a) => value.codePointAt(a.optNum(0) ?? 0),
  // `toString` is typed explicitly: object literals type that key from Object.prototype.
  toString: (value: string) => value,
  concat: (value, a) => {
    const parts = a.args.map((_, index) => a.str(index));
    assertBoundedStringLength(
      parts.reduce((total, part) => total + part.length, value.length),
      "String.concat",
      a.node,
    );
    return value.concat(...parts);
  },
});

export const invokeStringMethod = (
  value: string,
  name: string,
  args: InterpreterArray,
  node: AstNode,
): InterpreterValue => {
  const method = stringMethods.get(name);
  if (method === undefined)
    throw new InterpreterRuntimeError(
      `String method '${name}' is not available in CodeMode.`,
      node,
    );
  const result = method(value, stringArgs(name, args, node));
  return result instanceof CheckedResult
    ? result.value
    : boundedData(result, `String.${name} result`);
};
