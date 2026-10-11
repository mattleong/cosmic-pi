const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

export const safeTextPrefix = (value: string, maximumCodeUnits: number): string => {
  let end = Math.max(0, Math.min(value.length, Math.floor(maximumCodeUnits)));
  if (isHighSurrogate(value.charCodeAt(end - 1)) && isLowSurrogate(value.charCodeAt(end))) end -= 1;
  return value.slice(0, end);
};

export const safeTextSuffix = (value: string, maximumCodeUnits: number): string => {
  let start = Math.max(0, value.length - Math.max(0, Math.floor(maximumCodeUnits)));
  if (isLowSurrogate(value.charCodeAt(start)) && isHighSurrogate(value.charCodeAt(start - 1)))
    start += 1;
  return value.slice(start);
};

export const utf8ByteLength = (value: string): number => Buffer.byteLength(value, "utf8");

const codePointBytes = (character: string) => {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
};

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

export const utf8Suffix = (value: string, maxBytes: number): string => {
  if (utf8ByteLength(value) <= maxBytes) return value;
  const characters = Array.from(value);
  let used = 0;
  let start = characters.length;
  while (start > 0) {
    used += codePointBytes(characters[start - 1] ?? "");
    if (used > maxBytes) break;
    start -= 1;
  }
  return characters.slice(start).join("");
};
