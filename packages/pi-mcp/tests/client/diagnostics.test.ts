import { describe, expect, it } from "vitest";
import { mcpDiagnostic } from "../../src/client/diagnostics.ts";
import { boundaryError } from "../../src/client/errors.ts";
import { mcpFailureReply } from "../../src/boundary/host-tool-result.ts";

const reasons = [
  "oauth-resource-metadata-missing",
  "oauth-resource-metadata-invalid",
  "oauth-storage-unavailable",
  "oauth-mutation-unresolved",
  "oauth-browser-open-failed",
  "oauth-callback-timeout",
  "oauth-registration-unsupported",
  "oauth-binding-rejected",
  "oauth-deletion-failed",
  "oauth-finalization-failed",
  "rpc-method-not-found",
  "rpc-invalid-params",
  "rpc-invalid-request",
  "rpc-parse-error",
  "rpc-internal-error",
  "rpc-resource-not-found",
  "rpc-error",
] as const;
describe("fixed diagnostic recovery policy", () => {
  it("never copies exception text into diagnostics or gateway failures", () => {
    for (const reason of reasons) {
      const error = boundaryError(
        "unavailable",
        "not-sent",
        "https://issuer.example/authorize?state=PRIVATE_STATE PRIVATE_CODE PRIVATE_TOKEN",
        reason,
      );
      const diagnostic = mcpDiagnostic(error);
      expect(JSON.stringify([diagnostic, mcpFailureReply("auth", error)])).not.toMatch(
        /PRIVATE_|issuer\.example/,
      );
      expect(diagnostic.recovery.length).toBeGreaterThan(0);
    }
  });
  it("offers only currently available browser or explicit login actions", () => {
    const browser = boundaryError("unavailable", "not-sent", "", "oauth-browser-open-failed");
    expect(mcpDiagnostic(browser).recovery).not.toContain("reopen-browser");
    expect(mcpDiagnostic(browser, { canReopen: true }).recovery).toEqual(["reopen-browser"]);
    const expired = boundaryError("timeout", "not-sent", "", "oauth-callback-timeout");
    expect(mcpDiagnostic(expired).recovery).not.toContain("sign-in");
    expect(mcpDiagnostic(expired, { canSignIn: true }).recovery).toContain("sign-in");
  });
  it("never suggests replay for completed or unknown operations", () => {
    for (const outcome of ["completed", "unknown"] as const)
      for (const reason of reasons)
        expect(
          mcpDiagnostic(boundaryError("unavailable", outcome, "", reason), {
            canReopen: true,
            canSignIn: true,
          }).recovery,
        ).toEqual(["inspect-operation"]);
  });
  it("preserves safe causes without inventing retained results for completed failures", () => {
    for (const reason of reasons) {
      const error = boundaryError("protocol", "completed", "private-server-message", reason);
      const detail = mcpDiagnostic({ ...error, outcome: "not-sent" });
      const completed = mcpDiagnostic(error, { canReopen: true, canSignIn: true });
      expect(completed.explanation).toContain(detail.explanation);
      expect(completed.recovery).toEqual(["inspect-operation"]);
      expect(completed.explanation).not.toMatch(
        /existing result|retained (?:output|result)|no .*dispatched/i,
      );
      const reply = mcpFailureReply("tools.search", error);
      expect(reply).toMatchObject({
        outcome: "completed",
        isError: true,
        data: { kind: "protocol", reason },
      });
      expect(reply.resultId).toBeUndefined();
      expect(JSON.stringify(reply)).not.toContain("private-");
    }
  });
  it.each(["invalid-input", "output-limit", "cleanup", "transport", "protocol"] as const)(
    "does not invent non-dispatch or retention for completed %s failures",
    (kind) => {
      const error = boundaryError(kind, "completed", "private-server-message");
      const diagnostic = mcpDiagnostic(error, { canSignIn: true, canReopen: true });
      expect(diagnostic.recovery).toEqual(["inspect-operation"]);
      expect(diagnostic.explanation).not.toMatch(
        /existing result|retained (?:output|result)|no .*dispatched/i,
      );
      expect(mcpFailureReply("tools.call", error).resultId).toBeUndefined();
    },
  );
  it("keeps missing metadata compatibility distinct from malformed metadata and leaves config untouched", () => {
    const missing = mcpDiagnostic(
      boundaryError("denied", "not-sent", "", "oauth-resource-metadata-missing"),
    );
    const invalid = mcpDiagnostic(
      boundaryError("denied", "not-sent", "", "oauth-resource-metadata-invalid"),
    );
    expect(missing.explanation).toContain("configured issuer");
    expect(invalid.explanation).toContain("cannot bypass");
    expect(missing.recovery).toEqual(["inspect-settings"]);
    expect(invalid.recovery).toEqual(["inspect-settings"]);
  });
  it.each(["not-sent", "completed", "unknown"] as const)(
    "does not interpret a cancelled %s operation as an authentication event",
    (outcome) => {
      const error = boundaryError("cancelled", outcome, "private-cancellation");
      const diagnostic = mcpDiagnostic(error, { canSignIn: true, canReopen: true });
      expect(`${diagnostic.title}\n${diagnostic.explanation}`).not.toMatch(
        /sign[- ]?in|log[- ]?(?:in|out)|credential|authenticat/i,
      );
      expect(diagnostic.recovery).toEqual([
        outcome === "not-sent" ? "inspect-status" : "inspect-operation",
      ]);
      const reply = mcpFailureReply("tools.call", error);
      expect(reply).toMatchObject({ outcome, isError: true, data: { kind: "cancelled" } });
      expect(reply.resultId).toBeUndefined();
    },
  );
  it("does not interpret an ordinary denied operation as auth rejection", () => {
    expect(
      mcpDiagnostic(boundaryError("denied", "not-sent", "expired token"), { canSignIn: true })
        .recovery,
    ).not.toContain("sign-in");
    expect(
      mcpDiagnostic(boundaryError("auth-required", "not-sent", "permission"), { canSignIn: true })
        .recovery,
    ).toContain("sign-in");
  });
});
