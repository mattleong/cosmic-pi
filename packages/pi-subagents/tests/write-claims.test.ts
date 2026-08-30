import { describe, expect, it } from "vitest";
import {
  firstWriteClaimConflict,
  normalizeWriteClaims,
  writeClaimContains,
} from "../src/domain/write-claims.ts";

describe("write claims", () => {
  it("normalizes exact workspace-relative paths and removes case-insensitive duplicates", () => {
    expect(
      normalizeWriteClaims([
        "packages/auth/src/token.ts",
        "packages/auth/src/TOKEN.ts",
        "packages/auth/tests/new-file.test.ts",
      ]),
    ).toEqual({
      ok: true,
      claims: ["packages/auth/src/token.ts", "packages/auth/tests/new-file.test.ts"],
    });
  });

  it.each([
    "/tmp/file.ts",
    "C:/tmp/file.ts",
    "../file.ts",
    "a/../file.ts",
    "a//file.ts",
    "a\\file.ts",
    "a.ts\nInjected prompt",
  ])("rejects unsafe or non-POSIX claim %s", (path) => {
    expect(normalizeWriteClaims([path])).toMatchObject({ ok: false });
  });

  it.each(["<outside workspace>", "<OUTSIDE WORKSPACE>", "  <Outside Workspace>  "])(
    "rejects the reserved outside-workspace marker %s",
    (path) => {
      expect(normalizeWriteClaims([path])).toMatchObject({
        ok: false,
        code: "write_claim_outside_workspace",
      });
      expect(writeClaimContains([path], "<outside workspace>")).toBe(false);
    },
  );

  it("treats omitted claims as exclusive and exact claims as case-insensitively overlapping", () => {
    expect(firstWriteClaimConflict(undefined, ["a.ts"])).toEqual({
      left: "<exclusive>",
      right: "a.ts",
    });
    expect(firstWriteClaimConflict(["A.ts"], ["a.ts"])).toEqual({
      left: "A.ts",
      right: "a.ts",
    });
    expect(firstWriteClaimConflict(["a.ts"], ["b.ts"])).toBeUndefined();
  });

  it("matches only exact files rather than directory prefixes", () => {
    expect(writeClaimContains(["src/auth.ts"], "src/auth.ts")).toBe(true);
    expect(writeClaimContains(["src/auth.ts"], "src/auth.ts/generated.ts")).toBe(false);
  });
});
