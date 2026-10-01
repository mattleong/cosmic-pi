import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class TokenVerificationError extends Schema.TaggedError<TokenVerificationError>()(
  "TokenVerificationError",
  {},
) {}

export type TokenVerifier = (supplied: string) => Effect.Effect<boolean, TokenVerificationError>;

const cryptoFailure = () => new TokenVerificationError();
const utf8 = new TextEncoder();

/**
 * Compare a secret through native HMAC verification, never a JavaScript equality loop.
 * The non-extractable key and expected MAC are private to this verifier; neither enters errors.
 */
export const makeTokenVerifier = (expected: string) =>
  Effect.gen(function* () {
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
