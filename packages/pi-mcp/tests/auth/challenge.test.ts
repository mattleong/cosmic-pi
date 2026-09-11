import { describe, expect, it } from "vitest";
import { copyAuthChallenge, getAuthChallenge, setAuthChallenge } from "../../src/auth/challenge.ts";
import { boundaryError } from "../../src/client/errors.ts";
import { mcpFailureReply } from "../../src/boundary/host-tool-result.ts";

const raw =
  'Bearer resource_metadata="https://private.example/metadata?secret=PRIVATE", scope="PRIVATE_SCOPE"';

describe("private authentication challenge evidence", () => {
  it("preserves only a bounded immutable attachment, never serialized error data", () => {
    const error = boundaryError("auth-required", "unknown", "fixed");
    const challenge = { status: 401 as const, wwwAuthenticate: raw };
    expect(setAuthChallenge(error, challenge)).toBe(error);
    challenge.wwwAuthenticate = "changed";
    expect(getAuthChallenge(error)).toEqual({ status: 401, wwwAuthenticate: raw });
    expect(Object.isFrozen(getAuthChallenge(error))).toBe(true);
    const wrapped = boundaryError(error.kind, error.outcome, error.message, "auth-oauth-required");
    expect(copyAuthChallenge(error, wrapped)).toBe(wrapped);
    expect(getAuthChallenge(wrapped)).toEqual(getAuthChallenge(error));
    expect(JSON.stringify([error, wrapped, mcpFailureReply("tools.call", wrapped)])).not.toMatch(
      /PRIVATE|private\.example|wwwAuthenticate|resource_metadata/,
    );
    expect(Object.keys(wrapped)).not.toContain("wwwAuthenticate");
    expect(getAuthChallenge(boundaryError("auth-required", "unknown", "fixed"))).toBeUndefined();
  });

  it("retains an overflow marker rather than accepting a truncated oversized header", () => {
    for (const length of [8_192, 8_193, 65_536]) {
      const error = setAuthChallenge(boundaryError("auth-required", "unknown", "fixed"), {
        status: 403,
        wwwAuthenticate: "x".repeat(length),
      });
      expect(getAuthChallenge(error)?.wwwAuthenticate.length).toBe(Math.min(length, 8_193));
    }
  });
});
