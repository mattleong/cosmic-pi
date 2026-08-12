/**
 * Local confinement layer over the vendored interpreter (not part of upstream OpenCode 2;
 * see PROVENANCE.md). The interpreter executes model-written programs in-process, so every
 * synchronous native operation it delegates to (regex matching, string building, collection
 * growth, console formatting) must be bounded up front: a native call cannot be preempted by
 * the Effect timeout once it has started.
 *
 * Three mechanisms live here:
 *
 * 1. **Regex confinement** - a static pattern guard rejects the constructions whose
 *    backtracking cannot be defensibly bounded (backreferences, nested quantifiers,
 *    alternation inside repeated groups, ambiguous alternation whose branches can start on
 *    the same input character - the anchored `(a|aa)(a|aa)...b` family - inline
 *    flag-modifier groups (`(?i:...)`, `(?ims-ims:...)`), whose local flag semantics the
 *    analysis does not model, oversized bounded
 *    repeats, more than `MAX_REGEX_UNBOUNDED_QUANTIFIERS` independent unbounded quantifiers
 *    - the polynomial family `/a*a*a*b/` - and quantifier/alternation combinations whose
 *    combined branch factor exceeds `MAX_REGEX_CHOICE_FACTOR`), and a per-operation
 *    subject-length cap scales down with the pattern's residual backtracking degree
 *    (unbounded quantifier + lookaround count + unanchored scanning) and its combined
 *    branch factor. This is a deliberately conservative screen: it does not make native
 *    matching preemptible, and admitted operations still run to completion. The caps are
 *    calibrated so the known hostile families' measured worst cases stay in roughly the low
 *    tens of milliseconds on current V8; that is a calibration target, not a proven bound
 *    for every admissible pattern, so a deadline overrun inside one native match is
 *    expected to stay small but cannot be mathematically guaranteed.
 * 2. **Amplification limits** - fixed maximum sizes for guest strings, collections, and
 *    captured log output, enforced with preflight checks before native allocation wherever
 *    the result size is predictable (the projected output is counted first and the first
 *    overrun is refused before the native call runs; an exact fit is admitted), and at the
 *    shared data checkpoints otherwise.
 * 3. **Wall-clock deadline** - a shared deadline checked between interpreter steps and
 *    around synchronous native operations, so an execution that overruns `timeoutMs` inside
 *    synchronous work is normalized to `TimeoutExceeded` as soon as control returns to the
 *    interpreter instead of racing the Effect timer. The deadline is cooperative: it cannot
 *    interrupt a native operation that has already started, which is why every admitted
 *    native operation must be bounded up front.
 *
 * All limits are fixed constants: they are deliberately not host or user configuration.
 */
import { type AstNode, InterpreterRuntimeError } from "./model.js";
import {
  classFirst,
  type FirstSet,
  firstSetsOverlap,
  foldCase,
  parseEscape,
  unionFirstSets,
} from "./regex-first-sets.js";

/** Maximum length (UTF-16 code units) of any guest-visible string value. */
export const MAX_GUEST_STRING_LENGTH = 4_194_304;

/** Maximum entries in any guest array, Map, Set, URLSearchParams, or plain object. */
export const MAX_GUEST_COLLECTION_ENTRIES = 262_144;

/** Maximum captured console entries per execution; further entries are dropped with a marker. */
export const MAX_LOG_ENTRIES = 256;

/** Maximum length (UTF-16 code units) of one captured console entry before truncation. */
export const MAX_LOG_ENTRY_LENGTH = 8_192;

/** Maximum regular-expression pattern source length. */
export const MAX_REGEX_PATTERN_LENGTH = 1_000;

/** Maximum finite bound in a counted repetition quantifier (`{m,n}`). */
export const MAX_REGEX_BOUNDED_REPEAT = 200;

/** Maximum optional/bounded-choice quantifiers (`?`, `{m,n}` with m < n) per pattern. */
export const MAX_REGEX_OPTIONAL_QUANTIFIERS = 8;

/**
 * Maximum unbounded quantifiers (`*`, `+`, `{m,}`) plus lookaround groups per pattern.
 * Multiple independent unbounded quantifiers over overlapping character sets backtrack
 * polynomially - `/a*a*a*a*a*a*b/` stalls for ~half a second on a 44-character subject -
 * so the count is capped conservatively rather than trying to prove atom independence.
 */
export const MAX_REGEX_UNBOUNDED_QUANTIFIERS = 3;

/**
 * Maximum product of per-quantifier choice counts over the optional/variable quantifiers
 * (`?` contributes 2; `{m,n}` with m < n contributes n - m + 1) and per-alternation branch
 * counts (an admitted k-branch alternation contributes k). The product is the branch factor
 * those choice points multiply into every match attempt, so it divides the admitted subject
 * cap and is refused outright past this bound.
 */
export const MAX_REGEX_CHOICE_FACTOR = 256;

/**
 * Subject-length caps by residual backtracking degree (1-based index; degree =
 * unbounded-quantifier + lookaround count, plus 1 when the pattern must scan for a start
 * position). Worst-case backtracking for degree d grows like C(n + d, d), so the caps are
 * calibrated to keep every admitted operation's empirically measured worst case in roughly
 * the low tens of milliseconds on current V8. The admitted degree never exceeds this table
 * (MAX_REGEX_UNBOUNDED_QUANTIFIERS + 1), so no degree is silently clamped into a cap
 * calibrated for a cheaper pattern.
 */
const REGEX_SUBJECT_CAPS: ReadonlyArray<number> = [262_144, 2_048, 128, 64];

/** Smallest admitted subject cap after the optional-branch factor divides the degree cap. */
const REGEX_SUBJECT_CAP_FLOOR = 16;

export const regexSubjectCap = (degree: number, choiceFactor = 1): number => {
  const base = REGEX_SUBJECT_CAPS[Math.min(Math.max(degree, 1), REGEX_SUBJECT_CAPS.length) - 1]!;
  return Math.max(REGEX_SUBJECT_CAP_FLOOR, Math.floor(base / Math.max(choiceFactor, 1)));
};

const stringLimitError = (label: string, length: number, node?: AstNode) =>
  new InterpreterRuntimeError(
    `${label} would produce a string of ${length} characters, over the CodeMode maximum of ${MAX_GUEST_STRING_LENGTH}. Work with smaller pieces and return only the data you need.`,
    node,
    "InvalidDataValue",
  );

/** Preflight guard: rejects a predicted string length before the native allocation runs. */
export const assertBoundedStringLength = (length: number, label: string, node?: AstNode): void => {
  if (length > MAX_GUEST_STRING_LENGTH) throw stringLimitError(label, length, node);
};

/** Guard for collection growth (arrays, Maps, Sets, URLSearchParams, object entries). */
export const assertBoundedCollectionSize = (size: number, label: string, node?: AstNode): void => {
  if (size > MAX_GUEST_COLLECTION_ENTRIES) {
    throw new InterpreterRuntimeError(
      `${label} would hold ${size} entries, over the CodeMode maximum of ${MAX_GUEST_COLLECTION_ENTRIES}. Process the data in smaller batches and return only the data you need.`,
      node,
      "InvalidDataValue",
    );
  }
};

/**
 * Conservative upper bound on the length of `value` after URI percent-encoding, computed
 * without allocating: an ASCII code unit encodes to at most 3 characters (`%XX`), a
 * non-ASCII code unit to at most 9 (three UTF-8 bytes, `%XX` each). Used to preflight
 * `encodeURI`/`encodeURIComponent`, URL construction/property writes, and
 * `URLSearchParams.toString` before the native encoder materializes its output.
 */
export const uriEncodedLengthUpperBound = (value: string): number =>
  value.length * (/[\u0080-\uffff]/.test(value) ? 9 : 3);

/**
 * Conservative upper bound on the URLSearchParams entries a query string parses into: one
 * per `&` separator plus one, counted by indexOf scan with early bail and no allocation.
 * Empty segments (`a&&b`) are over-counted, which is safe: the count is only used to refuse.
 */
export const queryPairsUpperBound = (query: string): number => {
  if (query.length === 0) return 0;
  let pairs = 1;
  for (
    let found = query.indexOf("&");
    found !== -1 && pairs <= MAX_GUEST_COLLECTION_ENTRIES;
    found = query.indexOf("&", found + 1)
  ) {
    pairs += 1;
  }
  return pairs;
};

/**
 * Preflight guard for parsing one query string into URLSearchParams entries: the projected
 * pair count is charged before any native parser (URLSearchParams construction, a URL's
 * eagerly wrapped `searchParams`, or the `search` setter) materializes the entry list.
 */
export const assertBoundedQueryPairs = (query: string, label: string, node?: AstNode): void => {
  assertBoundedCollectionSize(queryPairsUpperBound(query), label, node);
};

/**
 * Preflight guard for constructing a URL from a full URL string: charges the query segment
 * (between the first `?` and the following `#`; fragment ampersands are ignored) before the
 * native URL - and the SandboxURL wrapper's eager `searchParams` access - parses it.
 * Conservative: a base URL's query is charged even when relative resolution would drop it.
 */
export const assertBoundedUrlQueryPairs = (url: string, label: string, node?: AstNode): void => {
  const query = url.indexOf("?");
  if (query === -1) return;
  const fragment = url.indexOf("#", query + 1);
  assertBoundedQueryPairs(
    url.slice(query + 1, fragment === -1 ? url.length : fragment),
    label,
    node,
  );
};

/**
 * Wall-clock source shared by every `ExecutionDeadline`. Production always uses `Date.now`;
 * tests may install a deterministic clock so deadline expiry inside synchronous native work
 * can be exercised without depending on real machine speed.
 */
let deadlineNow: () => number = Date.now;

/** Test seam: installs a deterministic wall-clock source; pass `undefined` to restore `Date.now`. */
export const setDeadlineClockForTesting = (clock: (() => number) | undefined): void => {
  deadlineNow = clock ?? Date.now;
};

/**
 * Shared wall-clock deadline for one execution. `check` is cheap (one clock read), is
 * called between interpreter steps and around synchronous native operations, and throws the
 * same normalized `TimeoutExceeded` diagnostic the Effect timeout produces. A synchronous
 * native operation that has already started cannot be preempted; the deadline guarantees the
 * overrun is observed and normalized at the next interpreter step instead of racing the
 * (event-loop-starved) Effect timer.
 */
export class ExecutionDeadline {
  private readonly expiresAt: number | undefined;
  private readonly timeoutMs: number | undefined;

  constructor(timeoutMs: number | undefined) {
    this.timeoutMs = timeoutMs;
    this.expiresAt = timeoutMs === undefined ? undefined : deadlineNow() + timeoutMs;
  }

  expired(): boolean {
    return this.expiresAt !== undefined && deadlineNow() > this.expiresAt;
  }

  check(node?: AstNode): void {
    if (this.expired()) {
      throw new InterpreterRuntimeError(
        `Execution timed out after ${this.timeoutMs}ms.`,
        node,
        "TimeoutExceeded",
      );
    }
  }
}

/** Result of the static pattern analysis for one admitted regular expression. */
interface PatternBudget {
  /** Unbounded quantifiers (`*`, `+`, `{m,}`) plus lookaround groups. */
  readonly unbounded: number;
  /** Product of the quantifier choice counts and alternation branch counts (branch factor). */
  readonly choiceFactor: number;
  /** True when every match attempt is pinned to the subject start (leading `^`, no `m`). */
  readonly anchored: boolean;
}

const budgetCache = new WeakMap<RegExp, PatternBudget>();

const rejectPattern = (regex: RegExp, reason: string, hint: string, node?: AstNode): never => {
  throw new InterpreterRuntimeError(
    `The regular expression /${regex.source}/${regex.flags} is not supported in CodeMode: ${reason}. ${hint}`,
    node,
    "UnsupportedSyntax",
  );
};

const NESTED_QUANTIFIER_HINT =
  "Patterns like (a+)+ can backtrack for seconds on small inputs; use a single quantifier (a+) or a bounded repetition instead.";
const POLYNOMIAL_QUANTIFIER_HINT =
  "Multiple unbounded quantifiers like a*a*a*b multiply into polynomial backtracking even on small subjects; combine adjacent quantifiers into one (a*b), anchor the pattern, or match each piece separately.";
const CHOICE_FACTOR_HINT =
  "Each optional or variable-count quantifier and each alternation multiplies worst-case backtracking; simplify the pattern or use exact counted repetitions ({m}).";
const ALTERNATION_HINT =
  "Repeated groups containing alternation, like (a|b)+, can backtrack exponentially; rewrite single-character alternatives as a character class ([ab]+) or match each alternative separately.";
const AMBIGUOUS_ALTERNATION_HINT =
  "Ambiguous alternation branches, like (a|ab), multiply backtracking into every match attempt; make each alternative start with a distinct character, rewrite single-character alternatives as a character class ([ab]), or match each alternative separately.";
const BACKREFERENCE_HINT =
  "Backreference matching can backtrack exponentially; restructure the pattern to match without backreferences and compare the captured groups in code.";
const MODIFIER_GROUP_HINT =
  "Inline flag groups like (?i:...) apply flags to only part of a pattern, which the CodeMode safety analysis does not model; apply the flag to the whole pattern (for example /.../i) or match that piece with a separate regular expression.";

/**
 * Valid inline flag-modifier group prefixes (`(?i:`, `(?ims:`, `(?i-m:`, `(?-i:`, `(?i-:`),
 * accepted by current V8. Requires at least one flag or a `-`, so the plain noncapturing
 * `(?:` prefix never matches. Deliberately over-approximate (duplicate/overlapping flags
 * would match too): only natively valid patterns reach the analyzer, so any match here is a
 * real modifier group.
 */
const MODIFIER_GROUP_PREFIX = /^\(\?(?:[ims]+-?[ims]*|-[ims]+):/;

/** Longest valid prefix is `(?` + up to 3 flags + `-` + up to 3 flags + `:`. */
const MODIFIER_GROUP_PREFIX_SPAN = 10;

interface GroupInfo {
  containsQuantifier: boolean;
  containsAlternation: boolean;
  isLookaround: boolean;
  /** Conservative first-sets of the group's completed alternation branches. */
  branchFirsts: Array<FirstSet>;
  /** First consumed atom's set for the in-progress branch (undefined: none seen yet). */
  currentFirst: FirstSet | undefined;
  /** True while the atom that set `currentFirst` is still the most recently scanned atom. */
  currentFirstPending: boolean;
}

const makeGroupInfo = (isLookaround: boolean): GroupInfo => ({
  containsQuantifier: false,
  containsAlternation: false,
  isLookaround,
  branchFirsts: [],
  currentFirst: undefined,
  currentFirstPending: false,
});

/**
 * Compact single-pass scanner over the pattern source. It does not fully validate the
 * pattern (the host `RegExp` constructor already did); it only extracts the confinement
 * facts: quantifier structure, alternation placement, backreferences, and group nesting.
 */
const analyzePattern = (regex: RegExp, node?: AstNode): PatternBudget => {
  const cached = budgetCache.get(regex);
  if (cached !== undefined) return cached;

  const source = regex.source;
  if (source.length > MAX_REGEX_PATTERN_LENGTH) {
    rejectPattern(
      regex,
      `the pattern is longer than ${MAX_REGEX_PATTERN_LENGTH} characters`,
      "Use a shorter pattern.",
      node,
    );
  }
  if (regex.flags.includes("v")) {
    rejectPattern(
      regex,
      "the v flag is not supported",
      "Use the u flag (or no unicode flag) instead.",
      node,
    );
  }

  const ignoreCase = regex.flags.includes("i");
  const unicodeMode = regex.flags.includes("u");
  let unbounded = 0;
  let optional = 0;
  let choiceFactor = 1;
  let topLevelAlternation = false;
  // Group stack; index 0 is the implicit top-level "group".
  const stack: Array<GroupInfo> = [makeGroupInfo(false)];
  // The group that the most recently completed atom was, when the atom was a group.
  let lastAtomGroup: GroupInfo | undefined;
  let index = 0;

  const markQuantifier = (): void => {
    for (const frame of stack) frame.containsQuantifier = true;
  };

  const top = (): GroupInfo => stack[stack.length - 1]!;

  // Records one consuming atom's conservative first-set for the in-progress branch.
  const noteAtomFirst = (first: FirstSet): void => {
    const frame = top();
    if (frame.currentFirst === undefined) {
      frame.currentFirst = first;
      frame.currentFirstPending = true;
    } else {
      frame.currentFirstPending = false;
    }
  };

  // Zero-width atoms (^, $, \b, \B, lookarounds) do not consume the branch's first character.
  const noteAssertion = (): void => {
    top().currentFirstPending = false;
  };

  const finishBranch = (frame: GroupInfo): void => {
    frame.branchFirsts.push(frame.currentFirst ?? "empty");
    frame.currentFirst = undefined;
    frame.currentFirstPending = false;
  };

  // Under the `u` flag the engine treats a surrogate pair (literal or \u escape) as one
  // character, so a quantifier after it applies to the whole pair. Consuming the low half
  // here keeps quantifier association - and therefore first-set invalidation - aligned.
  const consumeTrailingLowSurrogate = (): void => {
    const following = source[index];
    if (following === undefined) return;
    if (following === "\\") {
      const trailing = parseEscape(source, index, regex.flags, false);
      if (trailing.code !== undefined && trailing.code >= 0xdc00 && trailing.code <= 0xdfff) {
        index += trailing.width;
      }
      return;
    }
    const code = following.charCodeAt(0);
    if (code >= 0xdc00 && code <= 0xdfff) index += 1;
  };

  // Records one single-code-unit atom, pairing a high surrogate with its low half in
  // unicode mode before the (conservative, unit-level) first-set is noted.
  const noteCodeAtom = (code: number): void => {
    if (unicodeMode && code >= 0xd800 && code <= 0xdbff) consumeTrailingLowSurrogate();
    noteAtomFirst(foldCase([[code, code]], ignoreCase));
  };

  /**
   * Finishes a group (or the whole pattern): with 2+ branches, every branch must have a
   * bounded first-set and all branches must be pairwise disjoint on their first character -
   * the sound MVP screen against ambiguous alternation, whose choice points native matching
   * multiplies into every attempt (`(a|aa)(a|aa)...b`). Admitted alternations charge their
   * branch count into the global branch factor. Returns the group's own first-set.
   */
  const chargeAlternation = (frame: GroupInfo, node2?: AstNode): FirstSet => {
    finishBranch(frame);
    const branches = frame.branchFirsts;
    if (branches.length > 1) {
      for (const branch of branches) {
        if (branch === "empty") {
          rejectPattern(
            regex,
            "an alternation contains a branch that can match empty text",
            AMBIGUOUS_ALTERNATION_HINT,
            node2,
          );
        }
        if (branch === "unknown") {
          rejectPattern(
            regex,
            "an alternation branch's possible starting characters could not be conservatively determined",
            AMBIGUOUS_ALTERNATION_HINT,
            node2,
          );
        }
      }
      for (let left = 0; left < branches.length; left += 1) {
        for (let right = left + 1; right < branches.length; right += 1) {
          if (firstSetsOverlap(branches[left]!, branches[right]!)) {
            rejectPattern(
              regex,
              "two alternation branches can start with the same character",
              AMBIGUOUS_ALTERNATION_HINT,
              node2,
            );
          }
        }
      }
      choiceFactor *= branches.length;
    }
    return unionFirstSets(branches);
  };

  // `choices` is the quantifier's branch count: "unbounded" for `*`/`+`/`{m,}`, otherwise
  // the finite choice count (2 for `?`, n - m + 1 for `{m,n}`). `minimumIsZero` marks
  // quantifiers that admit zero occurrences, which invalidate a first-atom first-set.
  const applyQuantifier = (
    choices: number | "unbounded",
    minimumIsZero: boolean,
    span: number,
    node2?: AstNode,
  ): void => {
    if (lastAtomGroup !== undefined) {
      if (lastAtomGroup.isLookaround) {
        rejectPattern(
          regex,
          "a quantifier is applied to a lookaround group",
          NESTED_QUANTIFIER_HINT,
          node2,
        );
      }
      if (lastAtomGroup.containsQuantifier) {
        rejectPattern(
          regex,
          "a quantifier is applied to a group that itself contains a quantifier",
          NESTED_QUANTIFIER_HINT,
          node2,
        );
      }
      if (lastAtomGroup.containsAlternation) {
        rejectPattern(
          regex,
          "a quantifier is applied to a group containing alternation",
          ALTERNATION_HINT,
          node2,
        );
      }
    }
    if (choices === "unbounded") {
      unbounded += 1;
    } else {
      optional += 1;
      choiceFactor *= choices;
    }
    // A possibly-zero quantifier on the branch's first atom means the branch's first
    // consumed character may come from a later atom; conservatively unknown.
    const frame = top();
    if (minimumIsZero && frame.currentFirstPending) frame.currentFirst = "unknown";
    frame.currentFirstPending = false;
    markQuantifier();
    index += span;
    // Lazy modifier (`*?`, `+?`, `{m,n}?`) consumes the trailing `?` as part of the quantifier.
    if (source[index] === "?") index += 1;
    lastAtomGroup = undefined;
  };

  while (index < source.length) {
    const char = source[index]!;
    switch (char) {
      case "\\": {
        const next = source[index + 1];
        if (next !== undefined && next >= "1" && next <= "9") {
          rejectPattern(regex, "it contains a backreference", BACKREFERENCE_HINT, node);
        }
        if (next === "k") {
          rejectPattern(regex, "it contains a named backreference", BACKREFERENCE_HINT, node);
        }
        const escape = parseEscape(source, index, regex.flags, false);
        index += escape.width;
        if (escape.assertion === true) noteAssertion();
        else if (escape.code !== undefined) noteCodeAtom(escape.code);
        else if (escape.ranges !== undefined) noteAtomFirst(foldCase(escape.ranges, ignoreCase));
        else noteAtomFirst("unknown");
        lastAtomGroup = undefined;
        break;
      }
      case "[": {
        const parsed = classFirst(source, index, regex.flags);
        noteAtomFirst(parsed.first);
        index += parsed.width;
        lastAtomGroup = undefined;
        break;
      }
      case "(": {
        // Inline flag-modifier groups ((?i:...), (?ims-ims:...)) rebind flag semantics for
        // their subpattern; this analysis is flag-sensitive (case folding, escape parsing),
        // so a misread prefix could admit ambiguous alternation like (?i:a|aa). Rather than
        // model local flags, every valid modifier-group prefix is rejected outright.
        if (MODIFIER_GROUP_PREFIX.test(source.slice(index, index + MODIFIER_GROUP_PREFIX_SPAN))) {
          rejectPattern(
            regex,
            "it contains an inline flag-modifier group ((?flags:...) or (?flags-flags:...))",
            MODIFIER_GROUP_HINT,
            node,
          );
        }
        // A lookaround re-runs its subpattern at every attempted position, so it is charged
        // like an unbounded quantifier (its inner quantifiers are counted by this same pass
        // too); quantifying a lookaround is rejected outright.
        const isLookaround = /^\(\?<?[=!]/.test(source.slice(index, index + 4));
        if (isLookaround) unbounded += 1;
        stack.push(makeGroupInfo(isLookaround));
        if (source[index + 1] === "?") {
          // Skip the group-kind prefix: ?: ?= ?! ?<= ?<! ?<name>
          const named = /^\(\?<([^=!][^>]*)>/.exec(source.slice(index));
          index += named !== null ? named[0].length : source[index + 2] === "<" ? 4 : 3;
        } else {
          index += 1;
        }
        lastAtomGroup = undefined;
        break;
      }
      case ")": {
        const finished = stack.pop();
        index += 1;
        // A hostile/imbalanced source cannot occur (the host RegExp parsed it), but stay safe.
        if (finished === undefined || stack.length === 0) {
          rejectPattern(regex, "its group structure could not be analyzed", "", node);
          break; // unreachable: rejectPattern always throws
        }
        const groupFirst = chargeAlternation(finished, node);
        // A lookaround is zero-width; a group that consumed nothing contributes no first
        // character either. Every other group is the branch's next consuming atom.
        if (finished.isLookaround || groupFirst === "empty") noteAssertion();
        else noteAtomFirst(groupFirst);
        lastAtomGroup = finished;
        break;
      }
      case "|": {
        // Alternation anywhere inside a group subtree makes quantifying that group unsafe,
        // so it propagates to every open frame (like quantifiers do).
        for (const frame of stack) frame.containsAlternation = true;
        if (stack.length === 1) topLevelAlternation = true;
        finishBranch(top());
        index += 1;
        lastAtomGroup = undefined;
        break;
      }
      case "*":
        applyQuantifier("unbounded", true, 1, node);
        break;
      case "+":
        applyQuantifier("unbounded", false, 1, node);
        break;
      case "?":
        applyQuantifier(2, true, 1, node);
        break;
      case "{": {
        const counted = /^\{(\d+)(,(\d*)?)?\}/.exec(source.slice(index));
        if (counted === null) {
          // A literal `{` (annex-B), not a quantifier.
          noteAtomFirst(foldCase([[123, 123]], ignoreCase));
          index += 1;
          lastAtomGroup = undefined;
          break;
        }
        const minimum = Number(counted[1]);
        const hasComma = counted[2] !== undefined;
        const maximumText = counted[3];
        const maximum = !hasComma
          ? minimum
          : maximumText === undefined || maximumText === ""
            ? undefined
            : Number(maximumText);
        if (
          minimum > MAX_REGEX_BOUNDED_REPEAT ||
          (maximum !== undefined && maximum > MAX_REGEX_BOUNDED_REPEAT)
        ) {
          rejectPattern(
            regex,
            `a counted repetition exceeds {${MAX_REGEX_BOUNDED_REPEAT}}`,
            "Use a smaller bound.",
            node,
          );
        }
        if (maximum === undefined) {
          applyQuantifier("unbounded", minimum === 0, counted[0].length, node);
        } else if (maximum > minimum) {
          applyQuantifier(maximum - minimum + 1, minimum === 0, counted[0].length, node);
        } else {
          // Exact {m}: no choice points; still marks the enclosing groups as quantified.
          if (lastAtomGroup !== undefined && lastAtomGroup.containsQuantifier) {
            rejectPattern(
              regex,
              "a counted repetition is applied to a group that itself contains a quantifier",
              NESTED_QUANTIFIER_HINT,
              node,
            );
          }
          const frame = top();
          if (minimum === 0 && frame.currentFirstPending) frame.currentFirst = "unknown";
          frame.currentFirstPending = false;
          markQuantifier();
          index += counted[0].length;
          lastAtomGroup = undefined;
        }
        break;
      }
      default: {
        const code = source.charCodeAt(index);
        index += 1;
        if (char === ".") noteAtomFirst("unknown");
        else if (char === "^" || char === "$") noteAssertion();
        else noteCodeAtom(code);
        lastAtomGroup = undefined;
        break;
      }
    }
  }

  // The implicit top-level group is an alternation too (`a|aa`); same screen and charge.
  chargeAlternation(stack[0]!, node);

  if (optional > MAX_REGEX_OPTIONAL_QUANTIFIERS) {
    rejectPattern(
      regex,
      `it contains more than ${MAX_REGEX_OPTIONAL_QUANTIFIERS} optional quantifiers`,
      CHOICE_FACTOR_HINT,
      node,
    );
  }
  if (choiceFactor > MAX_REGEX_CHOICE_FACTOR) {
    rejectPattern(
      regex,
      `its alternations and optional/variable quantifiers multiply into a combined branch factor over ${MAX_REGEX_CHOICE_FACTOR}`,
      CHOICE_FACTOR_HINT,
      node,
    );
  }
  if (unbounded > MAX_REGEX_UNBOUNDED_QUANTIFIERS) {
    rejectPattern(
      regex,
      `it contains ${unbounded} unbounded quantifiers/lookarounds (maximum ${MAX_REGEX_UNBOUNDED_QUANTIFIERS})`,
      POLYNOMIAL_QUANTIFIER_HINT,
      node,
    );
  }

  const anchored = source.startsWith("^") && !topLevelAlternation && !regex.flags.includes("m");
  const budget: PatternBudget = { unbounded, choiceFactor, anchored };
  budgetCache.set(regex, budget);
  return budget;
};

/**
 * Validates one regular expression against the confinement rules. Runs at guest construction
 * time (literals, `new RegExp`, string patterns) for early diagnostics and is re-checked
 * (cached) before every native match operation, so host-supplied RegExp instances that
 * bypassed construction are confined too.
 */
export const assertConfinedRegExp = (regex: RegExp, node?: AstNode): void => {
  analyzePattern(regex, node);
};

/**
 * Guards one native match operation (`test`, `exec`, `match`, `matchAll`, `search`,
 * `replace`, `replaceAll`, `split`): the pattern must be admitted and the subject must fit
 * the cap for the pattern's residual backtracking degree.
 */
export const assertConfinedRegExpOperation = (
  regex: RegExp,
  subject: string,
  operation: string,
  node?: AstNode,
): void => {
  const budget = analyzePattern(regex, node);
  const degree = Math.max(1, budget.unbounded + (budget.anchored ? 0 : 1));
  const cap = regexSubjectCap(degree, budget.choiceFactor);
  if (subject.length > cap) {
    throw new InterpreterRuntimeError(
      `${operation} cannot run /${regex.source}/${regex.flags} against a ${subject.length}-character string in CodeMode; this pattern's backtracking budget allows subjects up to ${cap} characters. Match smaller pieces (for example split('\\n') and match each line), anchor the pattern with ^, or use string methods like includes/indexOf/startsWith.`,
      node,
      "InvalidDataValue",
    );
  }
};

/**
 * Bounded log sink over the interpreter's log array: entries beyond the caps are truncated
 * or dropped (with one final marker), so hostile programs cannot grow host memory through
 * `console.*` before the post-run output bound applies.
 */
export const appendBoundedLog = (logs: Array<string>, entry: string): void => {
  if (logs.length >= MAX_LOG_ENTRIES + 1) return;
  if (logs.length === MAX_LOG_ENTRIES) {
    logs.push(
      `[logs truncated: further console output beyond ${MAX_LOG_ENTRIES} entries was dropped]`,
    );
    return;
  }
  logs.push(
    entry.length > MAX_LOG_ENTRY_LENGTH
      ? `${entry.slice(0, MAX_LOG_ENTRY_LENGTH)}… [log entry truncated to ${MAX_LOG_ENTRY_LENGTH} characters]`
      : entry,
  );
};

/**
 * Estimates the serialized JSON size of an already-validated data value, bailing out as soon
 * as the estimate exceeds the guest string cap - a preflight for `JSON.stringify` so the
 * native serializer never materializes an over-limit string. `divisor` shrinks the budget
 * for indented output, whose size grows by up to depth x indent width over the compact form.
 */
export const assertBoundedJsonEstimate = (value: unknown, node?: AstNode, divisor = 1): void => {
  let remaining = Math.floor(MAX_GUEST_STRING_LENGTH / divisor);
  const spend = (amount: number): void => {
    remaining -= amount;
    if (remaining < 0) {
      throw new InterpreterRuntimeError(
        `JSON.stringify would produce more than ${MAX_GUEST_STRING_LENGTH} characters in CodeMode. Serialize a smaller value and return only the data you need.`,
        node,
        "InvalidDataValue",
      );
    }
  };
  const walk = (current: unknown): void => {
    if (current === null || current === undefined) {
      spend(4);
      return;
    }
    if (typeof current === "string") {
      spend(current.length + 2);
      return;
    }
    if (typeof current === "number" || typeof current === "boolean") {
      spend(8);
      return;
    }
    if (Array.isArray(current)) {
      spend(2 + current.length);
      for (const item of current) walk(item);
      return;
    }
    if (typeof current === "object") {
      const entries = Object.entries(current);
      spend(2 + entries.length);
      for (const [key, item] of entries) {
        spend(key.length + 3);
        walk(item);
      }
    }
  };
  walk(value);
};
