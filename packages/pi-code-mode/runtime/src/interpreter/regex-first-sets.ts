import * as Predicate from "effect/Predicate";

/**
 * Conservative first-character analysis for regular-expression alternation branches (local
 * confinement helper, not vendored from upstream OpenCode 2; see PROVENANCE.md deviation 8).
 *
 * Ambiguous alternation - two branches that can begin on the same input character - lets an
 * unquantified sequence like `(a|aa)(a|aa)...b` multiply a choice point into every match
 * attempt, which native matching cannot be preempted out of. `confinement.ts` uses these
 * helpers to reject, before any native match runs, every alternation whose branches cannot
 * be proven to start on disjoint characters.
 *
 * The analysis is deliberately over-approximate: a branch's computed set always contains
 * every code unit the branch can actually start with (or degrades to "unknown"), so a
 * false "disjoint" answer is impossible. The cost is that some safe alternations (shared
 * first letters, negated classes, `.`-led branches) are rejected.
 */

/** Inclusive code-unit range `[low, high]`. */
export type CodeUnitRange = readonly [number, number];

/**
 * Conservative set of code units one alternation branch can start with:
 *
 * - ranges: the branch's first consumed code unit lies inside one of them;
 * - `"unknown"`: the starting characters cannot be conservatively bounded (negated or
 *   unparseable classes, `.`, property escapes, a possibly-zero first quantifier, ...);
 * - `"empty"`: the branch may match without consuming a character.
 */
export type FirstSet = ReadonlyArray<CodeUnitRange> | "unknown" | "empty";

/** One parsed escape sequence (`\...`) as confinement facts, not full engine semantics. */
export interface EscapeAtom {
  /** Single code unit, when the escape denotes exactly one character. */
  readonly code?: number;
  /** Code-unit ranges, when the escape denotes a bounded class (`\d`, `\w`, `\s`). */
  readonly ranges?: ReadonlyArray<CodeUnitRange>;
  /** True for zero-width assertions (`\b`, `\B` outside a character class). */
  readonly assertion?: boolean;
  /** True when the matched characters cannot be conservatively bounded. */
  readonly unknown?: boolean;
  /** Source characters consumed, including the backslash. */
  readonly width: number;
}

const DIGIT_RANGES: ReadonlyArray<CodeUnitRange> = [[48, 57]];
const WORD_RANGES: ReadonlyArray<CodeUnitRange> = [
  [48, 57],
  [65, 90],
  [95, 95],
  [97, 122],
];
const SPACE_RANGES: ReadonlyArray<CodeUnitRange> = [
  [9, 13],
  [32, 32],
  [160, 160],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];

/**
 * Closes ranges under the `i` flag by adding the case-swapped ASCII letter counterparts.
 * Non-ASCII simple case folding (including the `k`/U+212A and `s`/U+017F foldings under
 * `iu`) is not modeled: any non-ASCII range under `i` degrades to "unknown", which keeps
 * the overlap answer conservative.
 */
export const foldCase = (ranges: ReadonlyArray<CodeUnitRange>, ignoreCase: boolean): FirstSet => {
  if (!ignoreCase) return ranges;
  const folded: Array<CodeUnitRange> = [...ranges];
  for (const [low, high] of ranges) {
    if (high > 127) return "unknown";
    const upperLow = Math.max(low, 65);
    const upperHigh = Math.min(high, 90);
    if (upperLow <= upperHigh) folded.push([upperLow + 32, upperHigh + 32]);
    const lowerLow = Math.max(low, 97);
    const lowerHigh = Math.min(high, 122);
    if (lowerLow <= lowerHigh) folded.push([lowerLow - 32, lowerHigh - 32]);
  }
  return folded;
};

const isHex = (text: string): boolean => text.length > 0 && /^[0-9a-fA-F]+$/.test(text);
const isDigit = (char: string | undefined): boolean =>
  char !== undefined && char >= "0" && char <= "9";

/**
 * Parses one `\`-escape with `index` at the backslash. Backreference escapes (`\1`-`\9`,
 * `\k`) never reach this outside a class: the confinement scanner rejects them first.
 * Widths follow engine parsing (a two-character fallback keeps the scanner aligned with
 * the annex-B literal reading), so a later quantifier associates with the right atom.
 */
export const parseEscape = (
  source: string,
  index: number,
  flags: string,
  inClass: boolean,
): EscapeAtom => {
  const next = source[index + 1];
  if (next === undefined) return { unknown: true, width: 1 };
  const unicodeMode = flags.includes("u");
  switch (next) {
    case "b":
      // Inside a class, \b is the backspace character; outside it is a boundary assertion.
      return inClass ? { code: 8, width: 2 } : { assertion: true, width: 2 };
    case "B":
      return inClass ? { unknown: true, width: 2 } : { assertion: true, width: 2 };
    case "d":
      return { ranges: DIGIT_RANGES, width: 2 };
    case "w":
      return { ranges: WORD_RANGES, width: 2 };
    case "s":
      return { ranges: SPACE_RANGES, width: 2 };
    case "D":
    case "W":
    case "S":
      // Negated classes cover almost everything; not worth modelling.
      return { unknown: true, width: 2 };
    case "p":
    case "P": {
      if (!unicodeMode) return { code: next.charCodeAt(0), width: 2 };
      const property = /^\\[pP]\{[^}]*\}/.exec(source.slice(index));
      return { unknown: true, width: property === null ? 2 : property[0].length };
    }
    case "n":
      return { code: 10, width: 2 };
    case "t":
      return { code: 9, width: 2 };
    case "r":
      return { code: 13, width: 2 };
    case "f":
      return { code: 12, width: 2 };
    case "v":
      return { code: 11, width: 2 };
    case "0":
      // Annex-B octal continuation (\07) changes the denoted character; stay conservative.
      return isDigit(source[index + 2]) ? { unknown: true, width: 2 } : { code: 0, width: 2 };
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
    case "6":
    case "7":
    case "8":
    case "9":
      // Octal/backreference forms inside a class (outside, the scanner rejected already).
      return { unknown: true, width: 2 };
    case "c": {
      const control = source[index + 2];
      if (control !== undefined && /[a-zA-Z]/.test(control)) {
        return { code: control.charCodeAt(0) % 32, width: 3 };
      }
      return { unknown: true, width: 2 };
    }
    case "x": {
      const hex = source.slice(index + 2, index + 4);
      if (hex.length === 2 && isHex(hex)) return { code: parseInt(hex, 16), width: 4 };
      return { unknown: true, width: 2 };
    }
    case "u": {
      if (unicodeMode) {
        const braced = /^\\u\{([0-9a-fA-F]+)\}/.exec(source.slice(index));
        if (braced !== null) {
          const codePoint = parseInt(braced[1]!, 16);
          const unit = codePoint > 0xffff ? 0xd800 + ((codePoint - 0x10000) >> 10) : codePoint;
          return { code: unit, width: braced[0].length };
        }
      }
      const hex = source.slice(index + 2, index + 6);
      if (hex.length === 4 && isHex(hex)) return { code: parseInt(hex, 16), width: 6 };
      return { unknown: true, width: 2 };
    }
    default:
      // Identity escape (\., \*, \[, ...): the escaped code unit itself.
      return { code: next.charCodeAt(0), width: 2 };
  }
};

/**
 * Parses one `[...]` class with `index` at the `[`, following the engine's rule that the
 * first `]` always closes the class (`[]` is an empty class, `[^]` matches any character;
 * a leading `]` is never a literal member). Negated or unparseable classes degrade to
 * "unknown". `width` spans through the closing `]`.
 */
export interface ClassFirstResult {
  readonly first: FirstSet;
  readonly width: number;
}

export const classFirst = (source: string, index: number, flags: string): ClassFirstResult => {
  let i = index + 1;
  let negated = false;
  let unknown = false;
  if (source[i] === "^") {
    negated = true;
    i += 1;
  }
  const ranges: Array<CodeUnitRange> = [];
  // Parses one member (single code or class-escape ranges); advances `i` past it.
  const member = (): number | "ranges" | "unknown" => {
    if (source[i] === "\\") {
      const atom = parseEscape(source, i, flags, true);
      i += atom.width;
      if (atom.code !== undefined) return atom.code;
      if (atom.ranges !== undefined) {
        ranges.push(...atom.ranges);
        return "ranges";
      }
      return "unknown";
    }
    const code = source.charCodeAt(i);
    i += 1;
    return code;
  };
  while (i < source.length && source[i] !== "]") {
    const low = member();
    if (low === "unknown") {
      unknown = true;
      continue;
    }
    if (low === "ranges") continue; // A class escape cannot start a range (annex-B literal -).
    if (source[i] === "-" && i + 1 < source.length && source[i + 1] !== "]") {
      i += 1; // consume the range dash
      const high = member();
      if (!Predicate.isNumber(high) || high < low) unknown = true;
      else ranges.push([low, high]);
      continue;
    }
    ranges.push([low, low]);
  }
  const closed = source[i] === "]";
  const width = (closed ? i + 1 : i) - index;
  if (negated || unknown || !closed) return { first: "unknown", width };
  return { first: foldCase(ranges, flags.includes("i")), width };
};

/** Union of branch first-sets; "unknown" dominates, "empty" survives only alone. */
export const unionFirstSets = (sets: ReadonlyArray<FirstSet>): FirstSet => {
  if (sets.length === 1) return sets[0]!;
  if (sets.some((set) => set === "unknown" || set === "empty")) return "unknown";
  // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
  return sets.flatMap((set) => set as ReadonlyArray<CodeUnitRange>);
};

/** True unless both sets are range lists with no intersecting pair. */
export const firstSetsOverlap = (a: FirstSet, b: FirstSet): boolean => {
  if (a === "unknown" || b === "unknown" || a === "empty" || b === "empty") return true;
  return a.some(([aLow, aHigh]) => b.some(([bLow, bHigh]) => aLow <= bHigh && bLow <= aHigh));
};
