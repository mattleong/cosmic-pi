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
import type { McpBoundaryError } from "../../src/client/errors.ts";

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
      expect(yield* Effect.isSuccess(validateAuthUrl("http://127.0.0.1:8000/token", policy))).toBe(
        true,
      );
      for (const value of [
        "http://127.0.0.1:8001/token",
        "http://example.com/token",
        "https://user:secret@example.com/token",
        "https://example.com/#fragment",
      ]) {
        expect(yield* Effect.isFailure(validateAuthUrl(value, policy))).toBe(true);
      }
      const privateAddress = [{ address: "127.0.0.1", family: 4 as const }];
      const addresses = (url: string) =>
        validateAuthAddresses(new URL(url), privateAddress, policy).pipe(Effect.isSuccess);
      expect(yield* addresses("https://configured.example/token")).toBe(true);
      expect(yield* addresses("https://discovered.example/token")).toBe(false);
    }),
  );
  it.effect("consumes invalid callbacks and rejects duplicate codes and fragments", () =>
    Effect.gen(function* () {
      const consume = singleUseCallback("http://127.0.0.1:8000/callback", "secret-state");
      const duplicate = singleUseCallback("http://127.0.0.1:8000/callback", "state");
      const rejected: Array<Effect.Effect<unknown, McpBoundaryError>> = [
        consume("http://127.0.0.1:8000/callback?state=wrong&code=secret-code"),
        consume("http://127.0.0.1:8000/callback?state=secret-state&code=secret-code"),
        duplicate("http://127.0.0.1:8000/callback?state=state&code=one&code=two"),
        parseAuthUrl("http://127.0.0.1:8000/callback?code=secret#state=x"),
      ];
      for (const effect of rejected) expect(yield* Effect.isFailure(effect)).toBe(true);
    }),
  );
});
