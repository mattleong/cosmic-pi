import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class TokenVerificationError extends Schema.TaggedError<
  TokenVerificationError,
  { readonly brand: unique symbol }
>()("TokenVerificationError", {}) {}

export type TokenVerifier = (supplied: string) => Effect.Effect<boolean, TokenVerificationError>;

const cryptoFailure = () => TokenVerificationError.make();
const utf8 = new TextEncoder();

export const makeTokenVerifier = Effect.fn("TokenVerifier.make")(function* (expected: string) {
  const key = yield* Effect.tryPromise({
    try: () =>
      globalThis.crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
        "verify",
      ]),
    catch: cryptoFailure,
  });
  const signature = yield* Effect.tryPromise({
    try: () => globalThis.crypto.subtle.sign("HMAC", key, utf8.encode(expected)),
    catch: cryptoFailure,
  });
  return (supplied: string): Effect.Effect<boolean, TokenVerificationError> =>
    Effect.tryPromise({
      try: () => globalThis.crypto.subtle.verify("HMAC", key, signature, utf8.encode(supplied)),
      catch: cryptoFailure,
    });
});
