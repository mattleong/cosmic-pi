import { describe, expect, it } from "vitest";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import { resolveTestConfig as resolve } from "./fixtures/profile-settings-inspection.ts";

describe("writer workspace configuration", () => {
  it("defaults existing documents to shared checkout", () => {
    expect(resolve({ version: 6 }).writerWorkspaceMode).toBe("shared-checkout");
  });

  it("preserves an explicitly saved worktree preference", () => {
    expect(resolve({ version: 6, writerWorkspaceMode: "worktree" }).writerWorkspaceMode).toBe(
      "worktree",
    );
  });

  it("inherits the global preference and only honors trusted project overrides", () => {
    const global = { version: 6, writerWorkspaceMode: "shared-checkout" };
    const project = { version: 6, writerWorkspaceMode: "worktree" };
    expect(resolve(global).writerWorkspaceMode).toBe("shared-checkout");
    expect(resolve(global, { version: 6 }).writerWorkspaceMode).toBe("shared-checkout");
    expect(resolve(global, project).writerWorkspaceMode).toBe("worktree");
    expect(resolve(global, project, false).writerWorkspaceMode).toBe("shared-checkout");
  });

  it("reports malformed preferences without retaining their values", () => {
    const decoded = decodeSubagentConfig({ version: 6, writerWorkspaceMode: "private-value" });
    expect(decoded.file.writerWorkspaceMode).toBeUndefined();
    expect(decoded.diagnostics).toContain("config.writerWorkspaceMode");
    expect(JSON.stringify(decoded)).not.toContain("private-value");
  });
});

describe("feature switch configuration", () => {
  it("leaves ultracode off by default", () => {
    expect(resolve({ version: 6 })).toMatchObject({
      ultracode: false,
      featureSources: { ultracode: "default" },
    });
  });

  it("resolves ultracode with trusted Project over Global", () => {
    const global = { version: 6, ultracode: true };
    expect(resolve(global)).toMatchObject({
      ultracode: true,
      featureSources: { ultracode: "global" },
    });
    expect(resolve(global, { version: 6 }).ultracode).toBe(true);
    expect(resolve(global, { version: 6, ultracode: false })).toMatchObject({
      ultracode: false,
      featureSources: { ultracode: "project" },
    });
    expect(resolve(global, { version: 6, ultracode: false }, false).ultracode).toBe(true);
    expect(resolve({ version: 6 }, { version: 6, ultracode: true }).ultracode).toBe(true);
  });

  it("reports non-boolean ultracode values without retaining them", () => {
    for (const value of ["true", 1, null, { enabled: true }]) {
      const decoded = decodeSubagentConfig({ version: 6, ultracode: value });
      expect(decoded.file.ultracode).toBeUndefined();
      expect(decoded.diagnostics).toContain("config.ultracode");
    }
  });
});
