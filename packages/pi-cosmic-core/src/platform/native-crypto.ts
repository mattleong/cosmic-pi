/**
 * Web Crypto primitives for synchronous Pi callbacks and native ownership commits.
 * There is no Effect runner or reflected Node import. Callers with a failure channel must
 * capture entropy failures at their existing Effect.try / host Promise boundary.
 */
import * as Hex from "effect/encoding/Hex";

const randomBytes = (size: number): Uint8Array =>
  globalThis.crypto.getRandomValues(new Uint8Array(size));

/** Secure entropy for bounded native path/receipt nonces. */
export const synchronousRandomHex = (bytes: number): string => Hex.encode(randomBytes(bytes));

/** Secure UUIDv4 for callbacks that must publish identity without yielding. */
export const synchronousRandomUuid = (): string => {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Hex.encode(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
