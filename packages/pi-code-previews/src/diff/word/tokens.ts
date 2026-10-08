import { requiredAt } from "./types";

export type WordEmphasisToken = {
  value: string;
  start: number;
  end: number;
};

export function tokenAt(tokens: WordEmphasisToken[], index: number): WordEmphasisToken {
  return requiredAt(tokens, index, "word-emphasis token");
}

const WORD_TOKEN_PATTERN =
  /[$_\p{L}][$_\p{L}\p{N}\p{Mark}]*|\p{N}+(?:\.\p{N}+)?|===|!==|=>|==|!=|<=|>=|&&|\|\||[^\s]/gu;
const IDENTIFIER_TOKEN_PATTERN = /^[$_\p{L}][$_\p{L}\p{N}\p{Mark}]*$/u;
const NUMBER_TOKEN_PATTERN = /^\p{N}+(?:\.\p{N}+)?$/u;
const SYMBOL_TOKEN_PATTERN = /^\p{S}+$/u;
const MEANINGFUL_OPERATOR_TOKEN_PATTERN =
  /^(?:===|!==|=>|==|!=|<=|>=|&&|\|\||[+\-*/%<>=!?:~&|^]+)$/;
const DOMAIN_SEPARATOR_TOKEN_PATTERN = /^[-/:@#]$/;
const STRUCTURAL_PUNCTUATION_TOKEN_PATTERN = /^[{}()[\].,;]$/;
const IDENTIFIER_PART_PATTERN =
  /[$_]+|(?:\p{Lu}\p{Mark}*)+(?=(?:\p{Lu}\p{Mark}*)(?:\p{Ll}\p{Mark}*)|\p{N}|$)|(?:\p{Lu}\p{Mark}*)?(?:\p{Ll}\p{Mark}*)+|\p{N}+|(?:\p{Lu}\p{Mark}*)+|(?:\p{L}\p{Mark}*)+/gu;

export function wordEmphasisTokens(text: string): WordEmphasisToken[] {
  return matchedTokens(text, WORD_TOKEN_PATTERN, 0);
}

/** `matchAll` iterates a clone, so the shared global patterns keep no `lastIndex` state. */
function matchedTokens(text: string, pattern: RegExp, offset: number): WordEmphasisToken[] {
  return Array.from(text.matchAll(pattern), ({ 0: value, index }) => ({
    value,
    start: offset + index,
    end: offset + index + value.length,
  }));
}

export function wordTokenValues(text: string): string[] {
  return Array.from(text.matchAll(WORD_TOKEN_PATTERN), (match) => match[0]);
}

export function isIdentifierToken(value: string): boolean {
  return IDENTIFIER_TOKEN_PATTERN.test(value);
}

export function isNumberToken(value: string): boolean {
  return NUMBER_TOKEN_PATTERN.test(value);
}

export function isSymbolToken(value: string): boolean {
  return SYMBOL_TOKEN_PATTERN.test(value);
}

export function isMeaningfulOperatorToken(value: string): boolean {
  return MEANINGFUL_OPERATOR_TOKEN_PATTERN.test(value);
}

export function wordEmphasisTokenWeight(value: string): number {
  if (isIdentifierToken(value)) return 2;
  if (isNumberToken(value)) return 1.5;
  if (DOMAIN_SEPARATOR_TOKEN_PATTERN.test(value)) return 0.25;
  if (isMeaningfulOperatorToken(value)) return 1;
  if (STRUCTURAL_PUNCTUATION_TOKEN_PATTERN.test(value)) return 0.05;
  return 1;
}

export function splitIdentifierToken(value: string, start: number): WordEmphasisToken[] {
  const parts = matchedTokens(value, IDENTIFIER_PART_PATTERN, start);
  return parts.length > 0 ? parts : [{ value, start, end: start + value.length }];
}

export function wordEmphasisSimilarityTokenValues(tokens: WordEmphasisToken[]): string[] {
  return tokens.flatMap(({ value }) => {
    if (!isIdentifierToken(value)) return [value];
    const parts = identifierSimilarityParts(value);
    return parts.length > 0 ? parts : [value.toLowerCase()];
  });
}

export function identifierSimilarityParts(value: string): string[] {
  return splitIdentifierToken(value, 0)
    .map((part) => part.value.toLowerCase())
    .filter((part) => !/^[$_]+$/.test(part));
}
