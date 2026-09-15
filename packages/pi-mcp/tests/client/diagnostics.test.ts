import { describe, expect, it } from "vitest";
import { mcpDiagnostic } from "../../src/client/diagnostics.ts";
import { boundaryError } from "../../src/client/errors.ts";
import { mcpFailureReply } from "../../src/boundary/host-tool-result.ts";

const reasons = [
  "auth-not-configured",
  "auth-env-required",
  "auth-env-sign-in-unsupported",
  "auth-oauth-required",
  "oauth-resource-metadata-missing",
  "oauth-resource-metadata-invalid",
  "oauth-storage-unavailable",
  "oauth-refresh-unresolved",
  "oauth-token-rejected",
  "oauth-insufficient-scope",
  "oauth-scope-approval-required",
  "oauth-scope-invalid",
  "oauth-mutation-unresolved",
  "oauth-browser-open-failed",
  "oauth-callback-timeout",
  "oauth-registration-unsupported",
  "oauth-pkce-unsupported",
  "oauth-client-auth-method-unsupported",
  "oauth-client-auth-method-ambiguous",
  "oauth-binding-rejected",
  "oauth-deletion-failed",
  "oauth-finalization-failed",
  "protocol-negotiation-rejected",
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
  it.each([
    "oauth-pkce-unsupported",
    "oauth-client-auth-method-unsupported",
    "oauth-client-auth-method-ambiguous",
  ] as const)("keeps %s actionable without automatically retrying sign-in", (reason) => {
    const error = boundaryError("unsupported", "not-sent", "private-registration-response", reason);
    expect(mcpDiagnostic(error, { canSignIn: true }).recovery).toEqual(["inspect-settings"]);
    expect(mcpFailureReply("auth", error)).toMatchObject({
      isError: true,
      outcome: "not-sent",
      data: { reason },
    });
    expect(mcpDiagnostic({ ...error, outcome: "unknown" }).recovery).toEqual(["inspect-operation"]);
  });
  it("requires permission review rather than unchanged sign-in for insufficient scopes", () => {
    for (const reason of [
      "oauth-insufficient-scope",
      "oauth-scope-approval-required",
      "oauth-scope-invalid",
    ] as const) {
      const error = boundaryError("auth-required", "not-sent", "PRIVATE_SCOPE", reason);
      expect(mcpDiagnostic(error, { canSignIn: true }).recovery).toEqual(["inspect-settings"]);
    }
    const refresh = boundaryError("auth-required", "not-sent", "", "oauth-refresh-unresolved");
    expect(mcpDiagnostic(refresh, { canSignIn: true }).recovery).toEqual([
      "check-storage",
      "inspect-status",
    ]);
    const token = boundaryError("auth-required", "not-sent", "", "oauth-token-rejected");
    expect(mcpDiagnostic(token, { canSignIn: true }).recovery).toEqual(["sign-in"]);
    expect(mcpDiagnostic(token).recovery).toEqual(["inspect-status"]);
  });
  it("routes authentication recovery by configured mode, not sign-in availability alone", () => {
    for (const reason of [
      "auth-not-configured",
      "auth-env-required",
      "auth-env-sign-in-unsupported",
    ] as const) {
      const error = boundaryError("auth-required", "not-sent", "private-token", reason);
      expect(mcpDiagnostic(error, { canSignIn: true }).recovery).toEqual(["inspect-settings"]);
    }
    const oauth = boundaryError("auth-required", "not-sent", "", "auth-oauth-required");
    expect(mcpDiagnostic(oauth, { canSignIn: true }).recovery).toEqual(["sign-in"]);
    expect(mcpDiagnostic(oauth).recovery).not.toContain("sign-in");
  });
  it("keeps auth configuration evidence with unknown discovery without authorizing replay", () => {
    const error = boundaryError("auth-required", "unknown", "private-token", "auth-not-configured");
    const cause = mcpDiagnostic({ ...error, outcome: "not-sent" });
    for (const action of [
      "tools.search",
      "tools.list",
      "tools.describe",
      "resources.list",
      "resources.templates",
      "prompts.list",
      "refresh",
    ]) {
      const detail = mcpDiagnostic(error, { action, canSignIn: true });
      expect(detail.explanation).toContain(cause.explanation);
      expect(detail.explanation).toMatch(/metadata discovery/);
      expect(detail.explanation).toMatch(/No tool invocation was requested/);
      expect(detail.recovery).toEqual(["inspect-operation"]);
      const reply = mcpFailureReply(action, error);
      expect(reply).toMatchObject({
        outcome: "unknown",
        isError: true,
        data: { reason: "auth-not-configured", message: detail.explanation },
      });
      expect(reply.notices.join(" ")).toMatch(/Do not replay/);
      expect(reply.resultId).toBeUndefined();
      expect(JSON.stringify(reply)).not.toContain("private-token");
    }
    for (const action of ["tools.call", "resources.read", "prompts.get", "future.action"]) {
      const detail = mcpDiagnostic(error, { action });
      expect(detail.explanation).not.toMatch(/No tool invocation was requested/);
      expect(detail.explanation).toContain(cause.explanation);
      expect(detail.recovery).toEqual(["inspect-operation"]);
    }
  });
  it("preserves fixed non-auth reasons alongside unknown-outcome warnings", () => {
    for (const reason of reasons) {
      const error = boundaryError("protocol", "unknown", "private-server-message", reason);
      const detail = mcpDiagnostic({ ...error, outcome: "not-sent" });
      const unknown = mcpDiagnostic(error, { action: "tools.list" });
      expect(unknown.explanation).toContain(detail.explanation);
      expect(unknown.recovery).toEqual(["inspect-operation"]);
      expect(JSON.stringify(mcpFailureReply("tools.list", error))).not.toContain("private-");
    }
    const negotiation = mcpDiagnostic(
      boundaryError("protocol", "not-sent", "", "protocol-negotiation-rejected"),
      { canSignIn: true },
    );
    expect(negotiation.recovery).toEqual(["inspect-settings"]);
  });
  it("gives only local prompt argument rejections a fixed discovery hint", () => {
    const privateText = "private-prompt-argument-value";
    const rejection = boundaryError("invalid-input", "not-sent", privateText);
    const reply = mcpFailureReply("prompts.get", rejection);
    expect(reply).toMatchObject({ outcome: "not-sent", isError: true });
    expect(reply.notices.join(" ")).toMatch(/prompts\.list.*same server.*arguments/);
    expect(reply.resultId).toBeUndefined();
    expect(JSON.stringify(reply)).not.toContain(privateText);
    for (const other of [
      mcpFailureReply("tools.call", rejection),
      mcpFailureReply("prompts.get", boundaryError("config", "not-sent", privateText)),
      mcpFailureReply("prompts.get", boundaryError("invalid-input", "completed", privateText)),
      mcpFailureReply("prompts.get", boundaryError("invalid-input", "unknown", privateText)),
      mcpFailureReply(
        "prompts.get",
        boundaryError("invalid-input", "not-sent", privateText, "rpc-invalid-params"),
      ),
    ]) {
      expect(other.notices.join(" ")).not.toContain("prompts.list");
      expect(JSON.stringify(other)).not.toContain(privateText);
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
  it("directs missing and invalid resource metadata to configuration review", () => {
    const missing = mcpDiagnostic(
      boundaryError("denied", "not-sent", "", "oauth-resource-metadata-missing"),
    );
    const invalid = mcpDiagnostic(
      boundaryError("denied", "not-sent", "", "oauth-resource-metadata-invalid"),
    );
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
