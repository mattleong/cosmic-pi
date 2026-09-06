import { describe, expect, it } from "vitest";
import {
  eligibleUntrackedSource,
  excludedWorkspacePath,
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
  it("excludes explicit credential and generated paths, including tracked ones", () => {
    for (const value of [
      ".env",
      "nested/.env.local",
      ".npmrc",
      "private.key",
      "secrets.json",
      "node_modules/a.js",
      "build/source.ts",
    ])
      expect(excludedWorkspacePath(value)).toBe(true);
    expect(eligibleUntrackedSource("src/new.ts")).toBe(true);
    expect(eligibleUntrackedSource("arbitrary.dat")).toBe(false);
  });
  it("does not confuse code references with literal credentials", () => {
    expect(
      sensitive("apiKey: provider.apiKey, client_secret = someVariable; password: Schema.String"),
    ).toBe(false);
    expect(sensitive('apiKey: "placeholder-token"')).toBe(false);
    expect(sensitive('apiKey: "stored-key", access_token: "refreshed-access-secret"')).toBe(false);
    expect(sensitive(`apiKey: "${"ghp_" + "A".repeat(36)}"`)).toBe(true);
    expect(sensitive(["-----BEGIN RSA", "PRIVATE KEY-----"].join(" "))).toBe(true);
  });
});
