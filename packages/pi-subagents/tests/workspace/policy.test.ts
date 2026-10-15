import { describe, expect, it } from "vitest";
import {
  credentialWorkspacePath,
  dependencyWorkspacePath,
  eligibleUntrackedSource,
  safeWorkspacePath,
  sensitiveWorkspaceContent,
} from "../../src/workspace/policy.ts";

const sensitive = (value: string) => sensitiveWorkspaceContent(new TextEncoder().encode(value));
describe("workspace snapshot policy", () => {
  it("rejects traversal and platform-ambiguous paths", () => {
    for (const value of [
      "../a.ts",
      "/a.ts",
      "a//b",
      "a/./b",
      "a/.git/config",
      "a\\b",
      "C:a",
      "a\nb",
    ])
      expect(safeWorkspacePath(value)).toBe(false);
    expect(safeWorkspacePath("src/a b.ts")).toBe(true);
  });
  it("keeps credential names and dependency directories out of untracked source", () => {
    for (const value of [".env", "nested/.env.local", ".npmrc", "private.key", "secrets.json"]) {
      expect(credentialWorkspacePath(value)).toBe(true);
      expect(dependencyWorkspacePath(value)).toBe(false);
      expect(eligibleUntrackedSource(value)).toBe(false);
    }
    for (const value of ["node_modules/a.js", "build/source.ts", "packages/x/dist/a.js"]) {
      expect(dependencyWorkspacePath(value)).toBe(true);
      expect(eligibleUntrackedSource(value)).toBe(false);
    }
    expect(eligibleUntrackedSource("src/new.ts")).toBe(true);
    expect(eligibleUntrackedSource("arbitrary.dat")).toBe(false);
  });
  it("does not confuse code references with literal credentials", () => {
    expect(
      sensitive("apiKey: provider.apiKey, client_secret = someVariable; password: Schema.String"),
    ).toBeUndefined();
    expect(sensitive('apiKey: "placeholder-token"')).toBeUndefined();
    expect(
      sensitive('apiKey: "stored-key", access_token: "refreshed-access-secret"'),
    ).toBeUndefined();
    expect(sensitive(`ok\napiKey: "${"ghp_" + "A".repeat(36)}"`)?.line).toBe(2);
    expect(sensitive(["-----BEGIN RSA", "PRIVATE KEY-----"].join(" "))).toBeDefined();
  });
});
