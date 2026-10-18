import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { synchronousRandomHex } from "pi-cosmic-core";

/** Bytes in each side's fresh challenge. */
export const NONCE_BYTES = 32;
/** Bytes in an HMAC-SHA-256 proof. */
export const PROOF_BYTES = 32;

/**
 * Each side proves it holds the record's token by signing both challenges under its own role, so
 * a proof can't be replayed on another connection or reflected back as the other side's.
 */
type Role = "server" | "client";

export class IntercomHandshakeError extends Schema.TaggedError<IntercomHandshakeError>()(
  "IntercomHandshakeError",
  {},
) {}

const failure = () => new IntercomHandshakeError();
const utf8 = new TextEncoder();

const transcript = (role: Role, clientNonce: string, serverNonce: string) =>
  utf8.encode(`pi-intercom/${role}\n${clientNonce}\n${serverNonce}`);

export const freshNonce: Effect.Effect<string> = Effect.sync(() =>
  synchronousRandomHex(NONCE_BYTES),
);

/** Proves and checks possession of one runtime's token without ever revealing it. */
export interface HandshakeKey {
  readonly prove: (
    role: Role,
    clientNonce: string,
    serverNonce: string,
  ) => Effect.Effect<string, IntercomHandshakeError>;
  /** Whether `proof` was made with the same token for `role` over these challenges. */
  readonly check: (
    role: Role,
    clientNonce: string,
    serverNonce: string,
    proof: string,
  ) => Effect.Effect<boolean, IntercomHandshakeError>;
}

export const handshakeKey = (token: string): Effect.Effect<HandshakeKey, IntercomHandshakeError> =>
  Effect.tryPromise({
    try: () =>
      globalThis.crypto.subtle.importKey(
        "raw",
        utf8.encode(token),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      ),
    catch: failure,
  }).pipe(
    Effect.map((key) => ({
      prove: (role, clientNonce, serverNonce) =>
        Effect.tryPromise({
          try: () =>
            globalThis.crypto.subtle.sign("HMAC", key, transcript(role, clientNonce, serverNonce)),
          catch: failure,
        }).pipe(Effect.map((signature) => Hex.encode(new Uint8Array(signature)))),
      check: (role, clientNonce, serverNonce, proof) => {
        const signature = Hex.decode(proof);
        if (Result.isFailure(signature)) return Effect.succeed(false);
        const bytes = new Uint8Array(signature.success);
        // WebCrypto compares in constant time.
        return Effect.tryPromise({
          try: () =>
            globalThis.crypto.subtle.verify(
              "HMAC",
              key,
              bytes,
              transcript(role, clientNonce, serverNonce),
            ),
          catch: failure,
        });
      },
    })),
  );
