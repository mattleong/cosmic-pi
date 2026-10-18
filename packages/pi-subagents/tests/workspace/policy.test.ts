import { describe, expect, it } from "vitest";
import {
  blockingUncapturedPath,
  capturablePrivatePath,
  credentialWorkspacePath,
  dependencyWorkspacePath,
  eligibleUntrackedSource,
  safeWorkspacePath,
} from "../../src/workspace/policy.ts";
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
  it("leaves credential files out of private trees without blocking, but not credential-named source", () => {
    for (const value of [".env.local", ".npmrc", "keys/deploy.key", "id_ed25519", "secrets.yaml"]) {
      expect(capturablePrivatePath(value)).toBe(false);
      expect(blockingUncapturedPath(value)).toBe(false);
    }
    for (const value of ["src/auth/credentials.ts", "lib/secrets.py", "src/secrets/store.go"])
      expect(capturablePrivatePath(value)).toBe(true);
    // An unsafe name still blocks, whatever it looks like.
    expect(blockingUncapturedPath("-id_rsa")).toBe(true);
  });
});
