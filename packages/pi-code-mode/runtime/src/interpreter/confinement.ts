/**
 * Local confinement layer over the vendored interpreter (not part of upstream OpenCode 2;
 * see PROVENANCE.md). The interpreter executes model-written programs in-process, so every
 * synchronous native operation it delegates to (regex matching, string building, collection
 * growth, console formatting) must be bounded up front: a native call cannot be preempted by
 * the Effect timeout once it has started.
 *
 * Three mechanisms, in three modules (this one holds the size limits and their guards;
 * `regex-guard.ts` the regex screen and subject caps; `deadline.ts` the deadline):
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

/** Maximum length (UTF-16 code units) of any guest-visible string value. */
export const MAX_GUEST_STRING_LENGTH = 4_194_304;

/** Maximum entries in any guest array, Map, Set, URLSearchParams, or plain object. */
export const MAX_GUEST_COLLECTION_ENTRIES = 262_144;

/**
 * Maximum promises, suspended generators, or queued promise jobs alive at once in one
 * execution. Each holds an interpreter activation, so this bounds retained memory well below
 * the collection cap.
 */
export const MAX_PENDING_PROMISES = 16_384;

/** Maximum captured console entries per execution; further entries are dropped with a marker. */
export const MAX_LOG_ENTRIES = 256;

/** Maximum length (UTF-16 code units) of one captured console entry before truncation. */
export const MAX_LOG_ENTRY_LENGTH = 8_192;

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

/** Guard for live asynchronous work: pending promises, suspended generators, and queued jobs. */
export const assertBoundedPendingWork = (count: number, label: string, node?: AstNode): void => {
  if (count > MAX_PENDING_PROMISES) {
    throw new InterpreterRuntimeError(
      `${label} would reach ${count}, over the CodeMode maximum of ${MAX_PENDING_PROMISES} at once. Process items in batches, awaiting each batch before starting the next.`,
      node,
      "InvalidDataValue",
    );
  }
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

/** Charges URL normalization and eager search-parameter parsing before native construction. */
export const assertBoundedUrlConstructionInputs = (
  input: string,
  base: string | undefined,
  label: string,
  node?: AstNode,
): void => {
  assertBoundedStringLength(
    uriEncodedLengthUpperBound(input) + (base === undefined ? 0 : uriEncodedLengthUpperBound(base)),
    label,
    node,
  );
  assertBoundedUrlQueryPairs(input, label, node);
  if (base !== undefined) assertBoundedUrlQueryPairs(base, label, node);
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
