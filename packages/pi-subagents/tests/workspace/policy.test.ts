import { describe, expect, it } from "vitest";
import { credentialPrivatePath, credentialWorkspacePath } from "../../src/workspace/policy.ts";

describe("workspace credential policy", () => {
  it("leaves every credential-shaped name out of a checkout capture", () => {
    for (const value of [".env", "nested/.env.local", ".npmrc", "private.key", "secrets.json"])
      expect(credentialWorkspacePath(value)).toBe(true);
    for (const value of ["src/new.ts", "notes.md", "build/output.js"])
      expect(credentialWorkspacePath(value)).toBe(false);
  });
  it("leaves credential files out of private trees, but not credential-named source", () => {
    for (const value of [".env.local", ".npmrc", "keys/deploy.key", "id_ed25519", "secrets.yaml"])
      expect(credentialPrivatePath(value)).toBe(true);
    for (const value of ["src/auth/credentials.ts", "lib/secrets.py", "src/secrets/store.go"])
      expect(credentialPrivatePath(value)).toBe(false);
  });
});
