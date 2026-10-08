// Pure string-budget helpers. UTF-8 budgets walk code points; totals use the native byte length.

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Longest prefix of at most `maximumCodeUnits` UTF-16 units that never splits a surrogate pair. */
export const safeTextPrefix = (value: string, maximumCodeUnits: number): string => {
  let end = Math.max(0, Math.min(value.length, Math.floor(maximumCodeUnits)));
  if (isHighSurrogate(value.charCodeAt(end - 1)) && isLowSurrogate(value.charCodeAt(end))) end -= 1;
  return value.slice(0, end);
};

/** Longest suffix of at most `maximumCodeUnits` UTF-16 units that never splits a surrogate pair. */
export const safeTextSuffix = (value: string, maximumCodeUnits: number): string => {
  let start = Math.max(0, value.length - Math.max(0, Math.floor(maximumCodeUnits)));
  if (isLowSurrogate(value.charCodeAt(start)) && isHighSurrogate(value.charCodeAt(start - 1)))
    start += 1;
  return value.slice(start);
};

/** UTF-8 byte length; a lone surrogate counts as the three bytes of its U+FFFD replacement. */
export const utf8ByteLength = (value: string): number => Buffer.byteLength(value, "utf8");

// Per-code-point sizes that agree with utf8ByteLength, including a lone surrogate's three bytes.
const codePointBytes = (character: string) => {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
};

/** Longest code-point prefix whose UTF-8 encoding fits `maxBytes`. */
export const utf8Prefix = (value: string, maxBytes: number): string => {
  let used = 0;
  let end = 0;
  for (const character of value) {
    used += codePointBytes(character);
    if (used > maxBytes) break;
    end += character.length;
  }
  return value.slice(0, end);
};

/** Longest code-point suffix whose UTF-8 encoding fits `maxBytes`. */
export const utf8Suffix = (value: string, maxBytes: number): string => {
  if (utf8ByteLength(value) <= maxBytes) return value;
  const characters = [...value];
  let used = 0;
  let start = characters.length;
  while (start > 0) {
    used += codePointBytes(characters[start - 1] ?? "");
    if (used > maxBytes) break;
    start -= 1;
  }
  return characters.slice(start).join("");
};
