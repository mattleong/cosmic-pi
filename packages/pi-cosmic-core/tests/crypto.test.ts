import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { synchronousRandomHex, synchronousRandomUuid } from "../src/platform/native-crypto.ts";
import { sha256Text } from "../src/security/sha256.ts";
import { makeTokenVerifier } from "../src/platform/token-verifier.ts";

describe("cryptographic identities", () => {
  it("preserves SHA-256 UTF-8 identities, including empty input", () => {
    expect(sha256Text("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Text("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Text("café 🌌")).toBe(
      "211dca14539981f75d33130e750bf99e1332682841e5ca117460a45ee0b3647c",
    );
  });

  it("uses fresh secure entropy and preserves UUIDv4 identity shape", () => {
    const first = synchronousRandomHex(32);
    const second = synchronousRandomHex(32);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toBe(second);
    const uuid = synchronousRandomUuid();
    expect(uuid).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    expect(synchronousRandomUuid()).not.toBe(uuid);
  });

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
