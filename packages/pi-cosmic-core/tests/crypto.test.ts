import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeTokenVerifier } from "../src/platform/token-verifier.ts";

describe("cryptographic identities", () => {
  it.effect("verifies only the complete secret through native cryptography", () =>
    Effect.gen(function* () {
      const secret = "4a".repeat(32);
      const verify = yield* makeTokenVerifier(secret);
      expect(yield* verify(secret)).toBe(true);
      for (const candidate of [
        "",
        secret.slice(1),
        `${secret}0`,
        `5${secret.slice(1)}`,
        "🌌".repeat(16),
      ])
        expect(yield* verify(candidate)).toBe(false);
      const other = yield* makeTokenVerifier("4b".repeat(32));
      expect(yield* other(secret)).toBe(false);
    }),
  );
});
