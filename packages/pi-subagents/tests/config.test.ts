import { describe, expect, it } from "vitest";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import { resolveTestConfig as resolve } from "./fixtures/profile-settings-inspection.ts";

describe("writer workspace configuration", () => {
  it.each([4, 5, 6])("defaults existing version %s documents to shared checkout", (version) => {
    expect(resolve({ version }).writerWorkspaceMode).toBe("shared-checkout");
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
  const toggles = (config: ReturnType<typeof resolve>) => ({
    scriptedWorkflows: config.scriptedWorkflows,
    automaticProfileRouting: config.automaticProfileRouting,
  });

  it.each([4, 5, 6])("enables both features for version %s documents that omit them", (version) => {
    expect(toggles(resolve({ version }))).toEqual({
      scriptedWorkflows: true,
      automaticProfileRouting: true,
    });
  });

  it("resolves each switch independently with trusted Project over Global", () => {
    const global = { version: 6, scriptedWorkflows: false, automaticProfileRouting: false };
    expect(toggles(resolve(global))).toEqual({
      scriptedWorkflows: false,
      automaticProfileRouting: false,
    });
    expect(toggles(resolve(global, { version: 6, scriptedWorkflows: true }))).toEqual({
      scriptedWorkflows: true,
      automaticProfileRouting: false,
    });
    expect(toggles(resolve(global, { version: 6, scriptedWorkflows: true }, false))).toEqual({
      scriptedWorkflows: false,
      automaticProfileRouting: false,
    });
    expect(
      toggles(resolve({ version: 6 }, { version: 6, automaticProfileRouting: false })),
    ).toEqual({ scriptedWorkflows: true, automaticProfileRouting: false });
  });

  it("reports non-boolean values and legacy declarations without retaining them", () => {
    for (const value of ["false", 0, null, { enabled: false }]) {
      const decoded = decodeSubagentConfig({ version: 6, scriptedWorkflows: value });
      expect(decoded.file.scriptedWorkflows).toBeUndefined();
      expect(decoded.diagnostics).toContain("config.scriptedWorkflows");
    }
    const legacy = decodeSubagentConfig({ version: 5, automaticProfileRouting: false });
    expect(legacy.file.automaticProfileRouting).toBeUndefined();
    expect(legacy.diagnostics).toContain("config.<unknown>");
  });
});
