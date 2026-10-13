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

describe("removed workflow preferences", () => {
  it("ignores the retired preference while preserving profile and nesting settings", () => {
    const document = {
      version: 6,
      ultracode: true,
      defaultProfileSet: "saved",
      profileSets: { saved: { profiles: { worker: "disabled" } } },
      nesting: { maxDirectChildren: 3, maxDepth: 1 },
      writerWorkspaceMode: "worktree",
    };
    const decoded = decodeSubagentConfig(document);
    expect(decoded.diagnostics).toEqual([]);
    expect(decoded.file).toEqual({
      version: 6,
      defaultProfileSet: "saved",
      profileSets: { saved: { profiles: { worker: "disabled" } } },
      nesting: { maxDirectChildren: 3, maxDepth: 1 },
      writerWorkspaceMode: "worktree",
    });
    expect(resolve(document)).toMatchObject({
      profiles: { worker: { candidates: [] } },
      nesting: { maxDirectChildren: 3, maxDepth: 1 },
      writerWorkspaceMode: "worktree",
    });
  });
});
