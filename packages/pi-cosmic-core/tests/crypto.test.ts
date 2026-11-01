import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import { synchronousRandomToken } from "../src/platform/native-crypto.ts";

describe("cryptographic identities", () => {
  it("mints fixed-width base-36 tokens that don't repeat", () => {
    const tokens = Arr.makeBy(64, () => synchronousRandomToken());
    for (const token of tokens) expect(token).toMatch(/^[0-9a-z]{10}$/u);
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});
