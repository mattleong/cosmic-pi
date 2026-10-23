import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type { WordChangeRanges } from "./types";
import {
  isIdentifierToken,
  isMeaningfulOperatorToken,
  isNumberToken,
  isSymbolToken,
  wordTokenValues,
} from "./tokens";

export function filterLowSignalWordEmphasis(
  before: string,
  after: string,
  ranges: WordChangeRanges,
): WordChangeRanges {
  const hasRemovedSignal = Arr.some(ranges.removed, (range) => hasSmartRangeSignal(before, range));
  const hasAddedSignal = Arr.some(ranges.added, (range) => hasSmartRangeSignal(after, range));
  return {
    removed: Arr.filter(ranges.removed, (range) =>
      shouldKeepSmartRange(Fn.pipe(before, Str.slice(range[0], range[1])), hasAddedSignal),
    ),
    added: Arr.filter(ranges.added, (range) =>
      shouldKeepSmartRange(Fn.pipe(after, Str.slice(range[0], range[1])), hasRemovedSignal),
    ),
  };
}

function hasSmartRangeSignal(content: string, range: [number, number]): boolean {
  const tokens = wordTokenValues(Fn.pipe(content, Str.slice(range[0], range[1])));
  return Arr.some(tokens, isSmartSignalToken);
}

function shouldKeepSmartRange(text: string, oppositeSideHasSignal: boolean): boolean {
  const tokens = wordTokenValues(text);
  const signalTokens = Arr.filter(tokens, isSmartSignalToken);
  if (signalTokens.length === 0) return false;
  const wordTokens = Arr.filter(
    signalTokens,
    (token) => isIdentifierToken(token) || isNumberToken(token),
  );
  const hasIntrinsicSignal = Arr.some(
    signalTokens,
    (token) => isMeaningfulOperatorToken(token) || isSymbolToken(token),
  );
  if (oppositeSideHasSignal || hasIntrinsicSignal) return true;
  return (
    !Arr.every(wordTokens, (token) => LOW_SIGNAL_SYNTAX_TOKENS.has(token)) &&
    !isWrapperCallNoise(text, wordTokens)
  );
}

function isSmartSignalToken(token: string): boolean {
  return (
    isIdentifierToken(token) ||
    isNumberToken(token) ||
    isMeaningfulOperatorToken(token) ||
    isSymbolToken(token)
  );
}

const LOW_SIGNAL_SYNTAX_TOKENS = new Set([
  "as",
  "const",
  "else",
  "export",
  "from",
  "function",
  "if",
  "import",
  "let",
  "var",
]);

const WRAPPER_CALL_TOKENS = new Set(["filter", "flatMap", "forEach", "map", "reduce"]);

function isWrapperCallNoise(text: string, tokens: string[]): boolean {
  return (
    tokens.length === 1 &&
    tokens[0] !== undefined &&
    WRAPPER_CALL_TOKENS.has(tokens[0]) &&
    /^[\s.()[\]{};,]*[$_\p{L}][$_\p{L}\p{N}\p{Mark}]*[\s.()[\]{};,]*$/u.test(text)
  );
}
