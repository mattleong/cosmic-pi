import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { codeUnitAt } from "./text-scan.ts";

// Bound once because the UTF-8 scans below call it per code unit.
const codeAt = codeUnitAt;

export const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
export const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

export const safeTextPrefix = (value: string, maximumCodeUnits: number): string => {
  let end = Math.max(0, Math.min(value.length, Math.floor(maximumCodeUnits)));
  if (
    Option.exists(Str.charCodeAt(value, end - 1), isHighSurrogate) &&
    Option.exists(Str.charCodeAt(value, end), isLowSurrogate)
  )
    end -= 1;
  return Fn.pipe(value, Str.slice(0, end));
};

export const safeTextSuffix = (value: string, maximumCodeUnits: number): string => {
  let start = Math.max(0, value.length - Math.max(0, Math.floor(maximumCodeUnits)));
  if (
    Option.exists(Str.charCodeAt(value, start), isLowSurrogate) &&
    Option.exists(Str.charCodeAt(value, start - 1), isHighSurrogate)
  )
    start += 1;
  return Fn.pipe(value, Str.slice(start));
};

export const utf8ByteLength = (value: string): number => Buffer.byteLength(value, "utf8");

/** UTF-8 bytes for one code unit outside a surrogate pair; a lone surrogate encodes as U+FFFD. */
const codeUnitBytes = (code: number) => (code < 0x80 ? 1 : code < 0x800 ? 2 : 3);

const codePointBytes = (character: string) =>
  character.length > 1 ? 4 : codeUnitBytes(codeAt(character, 0));

export const utf8Prefix = (value: string, maxBytes: number): string => {
  let used = 0;
  let end = 0;
  for (const character of value) {
    used += codePointBytes(character);
    if (used > maxBytes) break;
    end += character.length;
  }
  return Fn.pipe(value, Str.slice(0, end));
};

export const utf8Suffix = (value: string, maxBytes: number): string => {
  if (utf8ByteLength(value) <= maxBytes) return value;
  let used = 0;
  let start = value.length;
  while (start > 0) {
    const last = codeAt(value, start - 1);
    const paired = isLowSurrogate(last) && start > 1 && isHighSurrogate(codeAt(value, start - 2));
    used += paired ? 4 : codeUnitBytes(last);
    if (used > maxBytes) break;
    start -= paired ? 2 : 1;
  }
  return Fn.pipe(value, Str.slice(start));
};
