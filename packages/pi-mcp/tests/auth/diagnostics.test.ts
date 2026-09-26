import { describe, expect, it } from "vitest";
import { withAuthFailureReason } from "../../src/auth/diagnostics.ts";
import { getAuthChallenge, setAuthChallenge } from "../../src/auth/challenge.ts";
import { boundaryError } from "../../src/client/errors.ts";
import type { McpServerDefinition } from "../../src/config/model.ts";
import { testServer } from "../fixtures/services.ts";

const server = (definition: McpServerDefinition) =>
  testServer("owned", { identity: "owned", definition });
const http = {
  transport: "http" as const,
  url: "https://private.example/mcp",
  headers: { Authorization: "Bearer private-token" },
  denyTools: [],
};

describe("authentication failure evidence", () => {
  it("captures the admitted HTTP auth mode without changing execution certainty", () => {
    const modes = [
      { auth: { type: "none" as const }, reason: "auth-not-configured" },
      { auth: { type: "env" as const, env: "PRIVATE_ENV" }, reason: "auth-env-required" },
      {
        auth: { type: "oauth" as const, registration: "dynamic" as const, scopes: [] },
        reason: "auth-oauth-required",
      },
    ];
    for (const { auth, reason } of modes)
      for (const outcome of ["not-sent", "completed", "unknown"] as const) {
        const original = setAuthChallenge(
          boundaryError("auth-required", outcome, "fixed failure"),
          {
            status: 401,
            wwwAuthenticate: 'Bearer scope="PRIVATE_ENV"',
          },
        );
        const annotated = withAuthFailureReason(server({ ...http, auth }), original);
        expect(annotated).toMatchObject({
          kind: original.kind,
          outcome,
          message: original.message,
          reason,
        });
        expect(JSON.stringify(annotated)).not.toMatch(/private-token|PRIVATE_ENV|private\.example/);
        expect(original.reason).toBeUndefined();
        expect(getAuthChallenge(annotated)).toEqual(getAuthChallenge(original));
      }
  });
  it("preserves specific causes and never infers authentication from other failures or stdio", () => {
    const current = server({ ...http, auth: { type: "none" } });
    for (const error of [
      boundaryError("auth-required", "not-sent", "", "oauth-binding-rejected"),
      boundaryError("cleanup", "unknown", ""),
      boundaryError("denied", "completed", "expired token"),
    ])
      expect(withAuthFailureReason(current, error)).toBe(error);
    const error = boundaryError("auth-required", "unknown", "");
    expect(
      withAuthFailureReason(
        server({
          transport: "stdio",
          command: "owned",
          args: [],
          environment: {},
          denyTools: [],
        }),
        error,
      ),
    ).toBe(error);
  });
});
