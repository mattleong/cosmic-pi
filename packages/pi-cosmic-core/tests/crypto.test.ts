import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { synchronousRandomToken } from "../src/platform/native-crypto.ts";
import { makeTokenVerifier } from "../src/platform/token-verifier.ts";

describe("cryptographic identities", () => {
  it.effect("verifies only the complete secret through native cryptography", () =>
    Effect.gen(function* () {
      const secret = Fn.pipe("4a", Str.repeat(32));
      const verify = yield* makeTokenVerifier(secret);
      expect(yield* verify(secret)).toBe(true);
      for (const candidate of [
        "",
        Fn.pipe(secret, Str.slice(1)),
        `${secret}0`,
        `5${Fn.pipe(secret, Str.slice(1))}`,
        Fn.pipe("🌌", Str.repeat(16)),
      ])
        expect(yield* verify(candidate)).toBe(false);
      const other = yield* makeTokenVerifier(Fn.pipe("4b", Str.repeat(32)));
      expect(yield* other(secret)).toBe(false);
    }),
  );

  it("mints fixed-width base-36 tokens that don't repeat", () => {
    const tokens = Arr.makeBy(64, () => synchronousRandomToken());
    for (const token of tokens) expect(token).toMatch(/^[0-9a-z]{10}$/u);
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});
