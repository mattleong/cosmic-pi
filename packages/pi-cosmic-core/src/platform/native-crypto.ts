import * as Hex from "effect/encoding/Hex";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

const randomBytes = (size: number): Uint8Array =>
  globalThis.crypto.getRandomValues(new Uint8Array(size));

export const synchronousRandomHex = (bytes: number): string => Hex.encode(randomBytes(bytes));

export const synchronousRandomUuid = (): string => {
  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Hex.encode(bytes);
  const part = (start: number, end?: number) => Fn.pipe(hex, Str.slice(start, end));
  return `${part(0, 8)}-${part(8, 12)}-${part(12, 16)}-${part(16, 20)}-${part(20)}`;
};
