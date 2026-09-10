import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, test } from "vitest";
import {
  isPublicAddress,
  parseAuthUrl,
  singleUseCallback,
  validateAuthAddresses,
  validateAuthUrl,
} from "../../src/auth/policy.ts";

const policy = {
  privateOrigins: new Set(["https://configured.example", "http://127.0.0.1:8000"]),
  localHttpOrigins: new Set(["http://127.0.0.1:8000"]),
};
describe("OAuth destination and callback policy", () => {
  test.each([
    "0.0.0.0",
    "127.0.0.1",
    "10.0.0.1",
    "172.31.4.2",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "198.18.0.1",
    "192.0.2.1",
    "224.0.0.1",
    "255.255.255.255",
  ])("denies nonpublic IPv4 %s", (address) => {
    expect(isPublicAddress({ address, family: 4 })).toBe(false);
  });
  test.each([
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "2001:0:1::",
  ])("denies nonpublic IPv6 %s", (address) => {
    expect(isPublicAddress({ address, family: 6 })).toBe(false);
  });
  test("accepts global addresses", () => {
    expect(isPublicAddress({ address: "93.184.216.34", family: 4 })).toBe(true);
    expect(isPublicAddress({ address: "2606:4700:4700::1111", family: 6 })).toBe(true);
  });
  it.effect("limits local HTTP and private DNS to explicit origins", () =>
    Effect.gen(function* () {
      expect(
        (yield* validateAuthUrl("http://127.0.0.1:8000/token", policy).pipe(Effect.result))._tag,
      ).toBe("Success");
      for (const value of [
        "http://127.0.0.1:8001/token",
        "http://example.com/token",
        "https://user:secret@example.com/token",
        "https://example.com/#fragment",
      ]) {
        expect((yield* validateAuthUrl(value, policy).pipe(Effect.result))._tag).toBe("Failure");
      }
      const privateAddress = [{ address: "127.0.0.1", family: 4 as const }];
      expect(
        (yield* validateAuthAddresses(
          new URL("https://configured.example/token"),
          privateAddress,
          policy,
        ).pipe(Effect.result))._tag,
      ).toBe("Success");
      expect(
        (yield* validateAuthAddresses(
          new URL("https://discovered.example/token"),
          privateAddress,
          policy,
        ).pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
  );
  it.effect("consumes invalid callbacks and rejects duplicate codes and fragments", () =>
    Effect.gen(function* () {
      const consume = singleUseCallback("http://127.0.0.1:8000/callback", "secret-state");
      expect(
        (yield* consume("http://127.0.0.1:8000/callback?state=wrong&code=secret-code").pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* consume("http://127.0.0.1:8000/callback?state=secret-state&code=secret-code").pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      const duplicate = singleUseCallback("http://127.0.0.1:8000/callback", "state");
      expect(
        (yield* duplicate("http://127.0.0.1:8000/callback?state=state&code=one&code=two").pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* parseAuthUrl("http://127.0.0.1:8000/callback?code=secret#state=x").pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
    }),
  );
});
