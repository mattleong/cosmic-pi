// Pure string-budget helpers; UTF-8 sizes use code-point arithmetic, not node:buffer.

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Longest prefix of at most `maximumCodeUnits` UTF-16 units that never splits a surrogate pair. */
export const safeTextPrefix = (value: string, maximumCodeUnits: number): string => {
  let end = Math.max(0, Math.min(value.length, Math.floor(maximumCodeUnits)));
  if (isHighSurrogate(value.charCodeAt(end - 1)) && isLowSurrogate(value.charCodeAt(end))) end -= 1;
  return value.slice(0, end);
};

/**
 * Longest code-point prefix whose UTF-8 encoding fits `maxBytes`. A lone surrogate counts as the
 * three bytes of its U+FFFD replacement, matching TextEncoder and Buffer.byteLength.
 */
export const utf8Prefix = (value: string, maxBytes: number): string => {
  let used = 0;
  let end = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    used += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (used > maxBytes) break;
    end += character.length;
  }
  return value.slice(0, end);
};
